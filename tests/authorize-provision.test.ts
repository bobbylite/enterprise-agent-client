import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AuthorizeClient } from '../src/shared/authorize/remote';
import {
  decisionParameters,
  decisionTokensReady,
  delegationRulePlans,
  groupsComparisonUsesCollection,
  rulesReferenceIsApproved,
  userRulePlans,
} from '../src/shared/authorize/framework';
import { provisionAuthorize, type TfStore } from '../src/shared/authorize/provision';
import { parseEnterpriseConfig } from '../src/shared/config';

function memoryStore(): TfStore & { rows: Map<string, { remoteId: string; contentHash: string }> } {
  const rows = new Map<string, { remoteId: string; contentHash: string }>();
  return {
    rows,
    get(kind, name) {
      return rows.get(`${kind}:${name}`) ?? null;
    },
    put(kind, name, remoteId, contentHash) {
      rows.set(`${kind}:${name}`, { remoteId, contentHash });
    },
  };
}

function pingone() {
  const resources = new Map<string, Record<string, unknown>>();
  const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  let seq = 0;
  const client = new AuthorizeClient({
    sleep: async () => undefined,
    fetchImpl: async (url, init) => {
      const target = String(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ method, url: target, body });
      const marker = target.match(/\/(authorizationAttributes|authorizationServices|authorizationPolicies|authorizationVersions|decisionEndpoints)(?:\/([^/?]+))?(?:\/(tag))?$/);
      if (!marker) return json({ message: target }, 404);
      const kind = marker[1] ?? '';
      const id = marker[2];
      if (kind === 'authorizationVersions' && !id && method === 'GET') {
        return json({ _embedded: { authorizationVersions: [{ id: 'ver-1' }] } });
      }
      if (marker[3] === 'tag' && method === 'PUT') return json({ id: 'ver-1', tag: { updatedAt: '2026-01-01T00:00:00.000Z' } });
      if (id === 'ver-1' && method === 'GET') return json({ id: 'ver-1', tag: { updatedAt: '2026-01-01T00:00:00.000Z' } });
      if (!id) {
        if (method === 'GET') {
          const rows = [...resources.values()].filter((item) => item.kind === kind);
          return json({ _embedded: { [kind]: rows } });
        }
        const created = `id-${(seq += 1)}`;
        const saved = { ...(body ?? {}), id: created, version: 'v1', kind, children: body?.children ?? [] };
        resources.set(created, saved);
        return json(saved, 201);
      }
      if (method === 'GET') {
        const saved = resources.get(id);
        return saved ? json(saved) : json({ message: 'missing' }, 404);
      }
      const saved = { ...(resources.get(id) ?? {}), ...(body ?? {}), id, version: 'v2', kind };
      resources.set(id, saved);
      return json(saved);
    },
  });
  return { client, calls, resources };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function config() {
  const parsed = parseEnterpriseConfig(JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')));
  parsed.tenant.mode = 'pingone';
  parsed.tenant.apiHost = 'https://api.pingone.com';
  parsed.tenant.authHost = 'https://auth.pingone.com';
  parsed.tenant.environmentId = 'env-1';
  parsed.authorize.delegations = [{ humanSub: 'human-1', agentSub: 'agent-1', audience: 'api://agent', scope: 'mcp' }];
  return parsed;
}

describe('real Authorize scaffold', () => {
  it('builds attributes, services, and both policies, then does not write them again', async () => {
    const store = memoryStore();
    const fake = pingone();
    const enterprise = config();
    const first = await provisionAuthorize({
      config: enterprise,
      accessToken: 'worker-token',
      client: fake.client,
      store,
      adminGroup: 'Administrator',
      delegations: enterprise.authorize.delegations,
      alwaysCurrent: false,
    });
    expect(first.decisionEndpointId).toBeTruthy();
    const posts = fake.calls.filter((call) => call.method === 'POST').map((call) => `${call.url.split('/').pop()}:${String(call.body?.name ?? '')}`);
    expect(posts[0]).toBe('authorizationAttributes:EnterpriseAgent');
    expect(posts).toContain('authorizationAttributes:access-token');
    expect(posts).toContain('authorizationAttributes:tx-token');
    expect(posts).toContain('authorizationAttributes:risk-score');
    expect(posts).toContain('authorizationAttributes:introspect-client-secret');
    expect(posts).toContain('authorizationServices:EnterpriseAgent User Introspection');
    expect(posts).toContain('authorizationServices:EnterpriseAgent Delegation Introspection');
    expect(posts).toContain('authorizationPolicies:Enterprise Agent');
    expect(posts).toContain('authorizationPolicies:Enterprise Agent User');
    expect(posts).toContain('authorizationPolicies:Enterprise Agent Delegation');
    expect(posts.indexOf('authorizationAttributes:EnterpriseAgent')).toBeLessThan(posts.indexOf('authorizationServices:EnterpriseAgent User Introspection'));
    expect(posts.indexOf('authorizationServices:EnterpriseAgent User Introspection')).toBeLessThan(posts.indexOf('authorizationPolicies:Enterprise Agent User'));

    const request = fake.calls.find((call) => call.method === 'POST' && call.body?.name === 'access-token');
    expect(request?.body?.resolvers).toEqual([{ type: 'REQUEST' }]);
    expect(request?.body).not.toHaveProperty('processor');
    expect(request?.body?.parent).toEqual({ id: store.get('attribute', 'EnterpriseAgent')?.remoteId });
    const score = fake.calls.find((call) => call.method === 'POST' && call.body?.name === 'risk-score');
    expect(score?.body?.valueType).toEqual({ type: 'NUMBER' });

    const service = fake.calls.find((call) => call.method === 'POST' && call.body?.name === 'EnterpriseAgent User Introspection');
    expect(service?.body).not.toHaveProperty('parent');
    const settings = service?.body?.serviceSettings as {
      authentication: { type: string; name: { id: string }; password: { id: string } };
      body: string;
      url: string;
      timeoutMilliseconds: number;
    };
    expect(settings.authentication.type).toBe('BASIC');
    expect(settings.authentication.name.id).toBe(store.get('attribute', 'introspect-client-id')?.remoteId);
    expect(settings.authentication.password.id).toBe(store.get('attribute', 'introspect-client-secret')?.remoteId);
    expect(settings.body).toBe(`token={{${store.get('attribute', 'access-token')?.remoteId}}}`);
    expect(settings.url).toBe('https://auth.pingone.com/env-1/as/introspect');
    expect(settings.timeoutMilliseconds).toBe(3000);
    expect(JSON.stringify(service?.body)).not.toMatch(/client-secret|super-secret|password=/i);

    const userPut = fake.calls.filter((call) => call.method === 'PUT' && call.url.includes('/authorizationPolicies/')).find((call) => {
      const children = call.body?.children as { name?: string; type?: string }[] | undefined;
      return children?.some((child) => child.name === 'High risk or inactive token');
    });
    const rules = userPut?.body?.children as { type: string; effectSettings: { type: string }; statements: { attributes: unknown[]; payload: string }[]; id?: string }[];
    expect(rules[0]?.type).toBe('RULE');
    expect(rules[0]?.effectSettings.type).toBe('UNCONDITIONAL_DENY');
    expect(rules[0]?.statements[0]?.attributes).toEqual([]);
    expect(rules.at(-1)?.effectSettings.type).toBe('UNCONDITIONAL_PERMIT');
    expect(rulesReferenceIsApproved(userPut?.body)).toBe(false);
    expect(userPut?.body).toMatchObject({ id: expect.any(String), version: expect.any(String) });

    const delegationPut = fake.calls.filter((call) => call.method === 'PUT' && call.url.includes('/authorizationPolicies/')).find((call) => {
      const children = call.body?.children as { name?: string }[] | undefined;
      return children?.some((child) => child.name === 'Mapped human and agent');
    });
    expect(JSON.stringify(delegationPut?.body)).toContain('NOT_EQUALS');
    expect(JSON.stringify(delegationPut?.body)).not.toContain('isApproved');
    expect(groupsComparisonUsesCollection()).toBe(true);

    const parentPut = [...fake.calls].reverse().find((call) => call.method === 'PUT' && call.body?.combiningAlgorithm && JSON.stringify(call.body.combiningAlgorithm).includes('DENY_OVERRIDES'));
    const childAlgorithms = (parentPut?.body?.children as { combiningAlgorithm?: { algorithm?: string } }[] | undefined)?.map((child) => child.combiningAlgorithm?.algorithm);
    expect(childAlgorithms).toEqual(['FIRST_APPLICABLE', 'FIRST_APPLICABLE']);

    const endpointPut = fake.calls.find((call) => call.method === 'PUT' && call.url.includes('/decisionEndpoints/'));
    expect(endpointPut?.body?.authorizationVersion).toEqual({ id: 'ver-1' });

    const writes = fake.calls.filter((call) => call.method === 'POST' || call.method === 'PUT').length;
    await provisionAuthorize({
      config: enterprise,
      accessToken: 'worker-token',
      client: fake.client,
      store,
      adminGroup: 'Administrator',
      delegations: enterprise.authorize.delegations,
      alwaysCurrent: false,
    });
    expect(fake.calls.filter((call) => call.method === 'POST' || call.method === 'PUT')).toHaveLength(writes);
  });

  it('sends full attribute names, a numeric score, and placeholders', () => {
    expect(decisionTokensReady('', 'tx')).toBe(false);
    expect(decisionTokensReady('access', '   ')).toBe(false);
    const body = decisionParameters({
      userId: 'user-1',
      username: 'ada',
      groups: ['Administrator'],
      riskLevel: 'LOW',
      riskAction: 'allow',
      accessToken: 'access-token',
      txToken: 'tx-token',
      adminGroup: 'Administrator',
    });
    expect(body.parameters).toEqual({
      'EnterpriseAgent.access-token': 'access-token',
      'EnterpriseAgent.tx-token': 'tx-token',
      'EnterpriseAgent.risk-level': 'LOW',
      'EnterpriseAgent.risk-score': 10,
      'EnterpriseAgent.risk-action': 'allow',
      'EnterpriseAgent.admin-group': 'Administrator',
    });
    const unknown = decisionParameters({
      ...body,
      userId: 'user-1',
      username: 'ada',
      groups: [],
      riskLevel: 'UNKNOWN',
      riskAction: 'allow',
      accessToken: 'access-token',
      txToken: 'tx-token',
      adminGroup: 'Administrator',
    });
    expect(unknown.parameters['EnterpriseAgent.risk-level']).toBe('UNKNOWN');
    expect(unknown.parameters['EnterpriseAgent.risk-score']).toBe(0);
    expect(userRulePlans('Administrator').at(-1)?.effect).toBe('PERMIT');
    expect(delegationRulePlans([]).map((rule) => rule.name)).toEqual(['Active delegation']);
    expect(rulesReferenceIsApproved(delegationRulePlans([{ humanSub: 'h', agentSub: 'a', audience: '', scope: '' }]))).toBe(false);
  });
});
