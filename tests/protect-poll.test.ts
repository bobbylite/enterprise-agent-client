import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Repository } from '../src/main/db';
import { Runtime } from '../src/main/runtime';
import { parseBranding } from '../src/shared/branding';
import { parseEnterpriseConfig, type EnterpriseConfig } from '../src/shared/config';
import { nextProtectDelayMs } from '../src/shared/protect/poll';
import { MemorySecretStore } from '../src/shared/secrets';

describe('protect poll settings', () => {
  it('defaults the interval to 30 seconds', () => {
    const raw = JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')) as {
      protect: { pollIntervalSeconds?: number; pauseWhenHidden?: boolean };
    };
    expect(raw.protect.pollIntervalSeconds).toBe(30);
    delete raw.protect.pollIntervalSeconds;
    delete raw.protect.pauseWhenHidden;
    const parsed = parseEnterpriseConfig(raw);
    expect(parsed.protect.pollIntervalSeconds).toBe(30);
    expect(parsed.protect.pauseWhenHidden).toBe(false);
    expect(nextProtectDelayMs(30, null)).toBe(30_000);
    expect(nextProtectDelayMs(0, 10)).toBeNull();
    expect(nextProtectDelayMs(30, 45)).toBe(45_000);
    expect(nextProtectDelayMs(30, 5)).toBe(30_000);
  });
});

describe('protect polling', () => {
  it('polls on the interval, applies a new interval without a restart, and stops on sign-out and expiry', async () => {
    let now = 1_700_000_000_000;
    const harness = scheduler();
    const { runtime, config } = await boot({ now: () => now, schedule: harness.schedule });
    await runtime.setMockAdmin(true);
    const signedIn = await runtime.submitCredentials('ada', 'secret', '');
    expect(signedIn.features.policyTab).toBe(true);
    expect(signedIn.features.chat).toBe('allow');
    expect(harness.delays).toEqual([30_000]);

    config.protect.pollIntervalSeconds = 5;
    runtime.reloadProtectSettings();
    expect(harness.delays.at(-1)).toBe(5_000);

    const pending = harness.current;
    await runtime.logout();
    expect(harness.current).toBeNull();
    expect(runtime.state().risk).toBeNull();
    await pending?.();
    expect(runtime.state().risk).toBeNull();
    expect(harness.delays).toEqual([30_000, 5_000]);

    await runtime.setMockAdmin(true);
    await runtime.submitCredentials('ada', 'secret', '');
    const expiresAt = runtime.state().session?.expiresAt ?? 0;
    now = expiresAt;
    await harness.current?.();
    expect(runtime.state().risk?.level).toBe('LOW');
    expect(harness.current).toBeNull();
  });

  it('moves the risk indicator and Authorize gates when the mock scenario changes, including while polling is off', async () => {
    const harness = scheduler();
    const { runtime } = await boot({
      schedule: harness.schedule,
      patch: (config) => {
        config.protect.pollIntervalSeconds = 0;
        config.authorize.cacheMs = 600_000;
      },
    });
    await runtime.setMockAdmin(true);
    const signedIn = await runtime.submitCredentials('ada', 'secret', '');
    expect(signedIn.risk?.level).toBe('LOW');
    expect(signedIn.features.policyTab).toBe(true);
    expect(harness.delays).toEqual([]);

    const stepped = await runtime.setMockScenario('impossible_travel');
    expect(stepped.risk?.level).toBe('HIGH');
    expect(stepped.risk?.action).toBe('block');
    expect(stepped.features.policyTab).toBe(false);
    expect(stepped.features.pingoneTools).toBe(false);
    expect(stepped.features.mcpWrites).toBe(false);
    expect(stepped.features.chat).toBe('read_only');
    expect(harness.delays).toEqual([]);
  });

  it('does not overlap polls and skips a hidden window until it is active', async () => {
    let active = true;
    let inFlight = 0;
    let maxInFlight = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = scheduler();
    const { runtime } = await boot({
      schedule: harness.schedule,
      protectActive: () => active,
      patch: (config) => {
        config.protect.pauseWhenHidden = true;
      },
      collectSignals: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight -= 1;
        return 'signal';
      },
    });
    await runtime.submitCredentials('ada', 'secret', '');
    active = false;
    await harness.current?.();
    expect(inFlight).toBe(0);
    expect(harness.delays.length).toBeGreaterThan(1);

    active = true;
    const first = harness.current?.();
    for (let attempt = 0; attempt < 5 && inFlight === 0; attempt += 1) await Promise.resolve();
    expect(inFlight).toBe(1);
    const second = harness.current?.();
    expect(inFlight).toBe(1);
    release();
    await first;
    await second;
    expect(maxInFlight).toBe(1);
    expect(runtime.state().risk?.signalsCollected).toBe(true);
  });

  it('backs off on 429 Retry-After, keeps the last level on a transient error, and fails closed when scoring stays unavailable', async () => {
    const harness = scheduler();
    const seen: string[] = [];
    let riskPosts = 0;
    let decisionPosts = 0;
    const { runtime } = await boot({
      schedule: harness.schedule,
      collectSignals: async () => 'sdk-payload',
      secrets: await workerSecrets(),
      patch: (config) => {
        protectPatch(config);
        config.tokenExchange.audiences = [{ id: 'agent', audience: 'api://agent', scope: 'mcp' }];
        config.protect.reportedIp = '203.0.113.8';
        config.protect.pollIntervalSeconds = 30;
        config.authorize.decisionEndpointId = 'endpoint-1';
        config.authorize.cacheMs = 600_000;
      },
      fetchImpl: async (url, init) => {
        const target = String(url);
        const method = init?.method ?? 'GET';
        if (target.includes('/as/authorize')) {
          return json(200, {
            id: 'flow-1',
            status: 'USERNAME_PASSWORD_REQUIRED',
            _links: { 'usernamePassword.check': { href: 'https://auth.example/env-1/flows/flow-1' } },
          });
        }
        if (target.includes('/flows/')) {
          return json(200, {
            id: 'flow-1',
            status: 'COMPLETED',
            authorizeResponse: { code: 'auth-code' },
            _embedded: { user: { id: 'user-1', username: 'ada' } },
          });
        }
        if (target.includes('/as/token')) return json(200, { access_token: 'worker-token', expires_in: 3600, token_type: 'Bearer' });
        if (target.includes('/decisionEndpoints')) {
          decisionPosts += 1;
          return json(200, { decision: 'PERMIT' });
        }
        if (target.includes('/riskEvaluations') && method === 'POST') {
          riskPosts += 1;
          const body = JSON.parse(String(init?.body)) as { event?: { sdk?: { signals?: { data?: string } } } };
          seen.push(body.event?.sdk?.signals?.data ?? '');
          if (riskPosts === 2) {
            return json(429, { code: 'REQUEST_LIMITED', message: 'Slow down.' }, { 'retry-after': '45' });
          }
          if (riskPosts === 3) return json(503, { message: 'unavailable' });
          if (riskPosts === 4) return json(400, { message: 'evaluation unavailable' });
          const level = riskPosts >= 5 ? 'HIGH' : 'LOW';
          return json(200, { id: `eval-${riskPosts}`, result: { level }, details: {} });
        }
        if (method === 'PUT') return new Response('', { status: 200 });
        return json(500, { message: target });
      },
    });
    const signedIn = await runtime.submitCredentials('ada', 'secret', 'login-signal');
    expect(signedIn.risk?.level).toBe('LOW');
    expect(signedIn.features.chat).toBe('allow');
    expect(decisionPosts).toBe(1);
    expect(seen[0]).toBe('login-signal');

    await harness.current?.();
    expect(runtime.state().risk?.level).toBe('LOW');
    expect(harness.delays.at(-1)).toBe(45_000);
    expect(decisionPosts).toBe(1);
    expect(seen.at(-1)).toBe('sdk-payload');

    await harness.current?.();
    expect(runtime.state().risk?.level).toBe('LOW');
    expect(harness.delays.at(-1)).toBe(30_000);

    await harness.current?.();
    expect(runtime.state().risk?.level).toBe('UNKNOWN');
    expect(runtime.state().risk?.action).toBe('restrict_tools');
    expect(runtime.state().features.chat).toBe('allow');
    expect(decisionPosts).toBe(2);

    await harness.current?.();
    expect(runtime.state().risk?.level).toBe('HIGH');
    expect(runtime.state().risk?.action).toBe('block');
    expect(runtime.state().features.policyTab).toBe(false);
    expect(runtime.state().features.mcpWrites).toBe(false);
    expect(runtime.state().features.chat).toBe('read_only');
    expect(decisionPosts).toBe(3);
  });
});

function scheduler() {
  const delays: number[] = [];
  let current: (() => Promise<void>) | null = null;
  return {
    delays,
    get current() {
      return current;
    },
    schedule(delayMs: number, run: () => Promise<void>) {
      delays.push(delayMs);
      current = run;
      return () => {
        if (current === run) current = null;
      };
    },
  };
}

async function boot(input: {
  patch?: (config: EnterpriseConfig) => void;
  fetchImpl?: typeof fetch;
  secrets?: MemorySecretStore;
  now?: () => number;
  schedule?: (delayMs: number, run: () => Promise<void>) => () => void;
  collectSignals?: () => Promise<string>;
  protectActive?: () => boolean;
}) {
  const rawBranding = JSON.parse(readFileSync('branding/default.json', 'utf8')) as Record<string, unknown>;
  const branding = parseBranding({ ...rawBranding, appName: 'Northstar', agentName: 'Northstar' }, null);
  const config = parseEnterpriseConfig(JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')));
  input.patch?.(config);
  const runtime = await Runtime.create({
    config,
    branding,
    db: Repository.open(':memory:'),
    secrets: input.secrets ?? new MemorySecretStore(),
    appRoot: process.cwd(),
    attachmentsDir: mkdtempSync(join(tmpdir(), 'protect-poll-')),
    encryptionAvailable: true,
    fetchImpl: input.fetchImpl,
    now: input.now,
    schedule: input.schedule,
    collectSignals: input.collectSignals,
    protectActive: input.protectActive,
  });
  return { runtime, config };
}

function protectPatch(config: EnterpriseConfig): void {
  config.tenant.mode = 'pingone';
  config.tenant.authHost = 'https://auth.example';
  config.tenant.apiHost = 'https://api.example';
  config.tenant.environmentId = 'env-1';
  config.tenant.clientId = 'client-1';
  config.tokenExchange.clientId = 'worker';
  config.tokenExchange.audiences = [];
  config.protect.enabled = true;
}

async function workerSecrets(): Promise<MemorySecretStore> {
  const secrets = new MemorySecretStore();
  await secrets.set('workerClientSecret', 'worker-secret');
  return secrets;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
