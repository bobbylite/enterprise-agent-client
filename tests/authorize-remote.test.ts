import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AuthorizeClient, MANAGEMENT_POST_GAP_MS, remotePolicyBody, syncRemoteScaffold } from '../src/shared/authorize/remote';
import { scaffoldPolicies } from '../src/shared/authorize/policy';
import { parseEnterpriseConfig } from '../src/shared/config';

function config() {
  const parsed = parseEnterpriseConfig(JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')));
  parsed.tenant.apiHost = 'https://api.example';
  parsed.tenant.environmentId = 'env-1';
  return parsed;
}

function limited(status: number, retryAfter = '2'): Response {
  return new Response(JSON.stringify({ code: 'REQUEST_LIMITED', message: 'Rate limit exceeded' }), {
    status,
    headers: { 'content-type': 'application/json', 'retry-after': retryAfter },
  });
}

describe('Authorize HTTP', () => {
  it('retries 429 with Retry-After, exponential backoff, and jitter', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = new AuthorizeClient({
      random: () => 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) return limited(429, '2');
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const response = await client.request('https://api.example/policies');
    expect(response.status).toBe(200);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([2000 * 1.25, 4000 * 1.25]);
  });

  it('stops after the bounded retries and names how long to wait', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = new AuthorizeClient({
      maxAttempts: 3,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: async () => {
        calls += 1;
        return limited(429, '5');
      },
    });
    await expect(client.request('https://api.example/policies')).rejects.toThrow('PingOne is rate limiting, try again in 5s');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([5000, 10_000]);
  });

  it('does not retry an Authorize quota error', async () => {
    let calls = 0;
    const client = new AuthorizeClient({
      sleep: async () => {
        throw new Error('should not wait');
      },
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ code: 'REQUEST_LIMITED', details: [{ code: 'QUOTA_EXCEEDED' }] }), {
          status: 429,
          headers: { 'retry-after': '30' },
        });
      },
    });
    await expect(client.request('https://api.example/policies')).rejects.toThrow(/quota is exceeded/);
    expect(calls).toBe(1);
  });

  it('runs Authorize calls one at a time', async () => {
    let inFlight = 0;
    let max = 0;
    const client = new AuthorizeClient({
      fetchImpl: async () => {
        inFlight += 1;
        max = Math.max(max, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return new Response('{}', { status: 200 });
      },
    });
    await Promise.all([client.request('https://api.example/one'), client.request('https://api.example/two')]);
    expect(max).toBe(1);
  });

  it('creates only the starter policies PingOne does not already have', async () => {
    const remote: { id: string; name: string; description: string; enabled: boolean }[] = [];
    const posts: string[] = [];
    const attempts = new Map<string, number>();
    const client = new AuthorizeClient({
      random: () => 0,
      sleep: async () => undefined,
      maxAttempts: 2,
      fetchImpl: async (_url, init) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET') {
          return new Response(JSON.stringify({ _embedded: { authorizationPolicies: remote } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        const body = JSON.parse(String(init?.body)) as { name: string; description: string };
        const seen = (attempts.get(body.name) ?? 0) + 1;
        attempts.set(body.name, seen);
        if (body.name === 'Read-only risk' && seen <= 2) return limited(429, '0');
        if (remote.some((item) => item.name === body.name)) {
          return new Response(JSON.stringify({ message: 'duplicate' }), { status: 409 });
        }
        const id = `policy-${remote.length + 1}`;
        remote.push({ id, name: body.name, description: body.description, enabled: true });
        posts.push(body.name);
        return new Response(JSON.stringify({ id }), { status: 201, headers: { 'content-type': 'application/json' } });
      },
    });
    const starter = scaffoldPolicies('Administrator', 10, 'ada');
    const saved = new Map(starter.map((policy) => [policy.id, policy]));
    await expect(
      syncRemoteScaffold(config(), 'worker-token', starter, client, (policy) => saved.set(policy.id, policy)),
    ).rejects.toThrow('PingOne is rate limiting, try again in 1s');
    expect(posts).toEqual(['Session can use chat', 'Administrator tools', 'Medium risk']);
    expect(saved.get('enterprise-agent:session')?.remoteId).toBe('policy-1');
    expect(saved.get('enterprise-agent:read-only')?.remoteId).toBeNull();

    const resumed = await syncRemoteScaffold(config(), 'worker-token', [...saved.values()], client);
    expect(resumed.created.map((policy) => policy.name)).toEqual(['Read-only risk', 'High risk lockdown']);
    expect(posts).toHaveLength(5);
    const again = await syncRemoteScaffold(config(), 'worker-token', resumed.policies, client);
    expect(again.created).toEqual([]);
    expect(posts).toHaveLength(5);
    expect(again.policies[0]?.remoteId).toBe('policy-1');
  });

  it('omits parent on scaffold POST and pauses between creates', async () => {
    const sleeps: number[] = [];
    const bodies: Record<string, unknown>[] = [];
    const client = new AuthorizeClient({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: async (_url, init) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET') {
          return new Response(JSON.stringify({ _embedded: { authorizationPolicies: [] } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        return new Response(JSON.stringify({ id: `policy-${bodies.length}` }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const starter = scaffoldPolicies('Administrator', 10, 'ada');
    const synced = await syncRemoteScaffold(config(), 'worker-token', starter, client);
    expect(synced.created).toHaveLength(starter.length);
    expect(bodies).toHaveLength(starter.length);
    for (const body of bodies) {
      expect(body).not.toHaveProperty('parent');
      expect(JSON.stringify(body)).not.toContain('"parent"');
    }
    expect(remotePolicyBody(starter[0]!)).not.toHaveProperty('parent');
    expect(sleeps).toEqual(Array.from({ length: starter.length - 1 }, () => MANAGEMENT_POST_GAP_MS));
  });
});
