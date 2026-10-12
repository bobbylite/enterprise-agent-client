import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Repository } from '../src/main/db';
import { Runtime } from '../src/main/runtime';
import { parseBranding } from '../src/shared/branding';
import { parseEnterpriseConfig } from '../src/shared/config';
import { MemorySecretStore } from '../src/shared/secrets';
import type { ChatEvent } from '../src/shared/types';

async function boot(
  delayMs = 0,
  patch?: (config: ReturnType<typeof parseEnterpriseConfig>) => void,
  fetchImpl?: typeof fetch,
  secrets = new MemorySecretStore(),
  env?: Record<string, string | undefined>,
) {
  const rawBranding = JSON.parse(readFileSync('branding/default.json', 'utf8')) as Record<string, unknown>;
  const branding = parseBranding(
    { ...rawBranding, appName: 'Northstar', agentName: 'Northstar' },
    null,
  );
  const config = parseEnterpriseConfig(JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')));
  patch?.(config);
  const db = Repository.open(':memory:');
  const events: ChatEvent[] = [];
  const runtime = await Runtime.create({
    config,
    branding,
    db,
    secrets,
    appRoot: process.cwd(),
    attachmentsDir: mkdtempSync(join(tmpdir(), 'agent-')),
    encryptionAvailable: true,
    mockDelayMs: delayMs,
    emit: (event) => events.push(event),
    fetchImpl,
    env,
  });
  return { runtime, events, db };
}

describe('mock runtime', () => {
  it('signs in, blocks a bot, and steps up a new device', async () => {
    const { runtime } = await boot();
    const low = await runtime.submitCredentials('ada', 'secret', '');
    expect(low.session?.username).toBe('ada');
    expect(low.risk?.action).toBe('allow');
    expect(low.risk?.summary).toContain('LOW');

    await runtime.logout();
    await runtime.setMockScenario('bot');
    const blocked = await runtime.submitCredentials('ada', 'secret', '');
    expect(blocked.session).toBeNull();
    expect(blocked.login.phase).toBe('blocked');
    expect(blocked.risk?.reasons.map((reason) => reason.code)).toContain('BOT');

    await runtime.cancelLogin();
    await runtime.setMockScenario('new_device');
    const stepUp = await runtime.submitCredentials('ada', 'secret', '');
    expect(stepUp.session).toBeNull();
    expect(stepUp.login.phase).toBe('otp');
    const done = await runtime.submitOtp('123456', '');
    expect(done.session?.username).toBe('ada');
    expect(done.risk?.action).toBe('step_up_mfa');
  });

  it('streams a chat, asks before the echo tool, and records a routine run', async () => {
    const { runtime, events } = await boot();
    try {
      await runtime.submitCredentials('ada', 'secret', '');
      const server = (await runtime.listMcpServers()).find((item) => item.id === 'echo');
      expect(server).toBeTruthy();
      const connected = await runtime.connectMcp('echo');
      expect(connected.tools.map((tool) => tool.name)).toContain('echo');

      const snapshot = runtime.createConversation();
      const pending = runtime.sendMessage(snapshot.conversation.id, 'echo hello from the desk', []);
      const approval = await waitFor(events, (event) => event.type === 'approval-required');
      if (approval.type !== 'approval-required') throw new Error('missing approval');
      expect(approval.request.allowAlways).toBe(true);
      runtime.respondApproval(approval.request.id, 'once');
      await pending;
      const opened = runtime.openConversation(snapshot.conversation.id);
      const tool = opened.messages.flatMap((message) => message.tools).find((item) => item.toolName === 'echo');
      expect(tool?.status).toBe('done');
      expect(tool?.result).toContain('hello from the desk');
      expect(opened.messages.some((message) => message.content.includes('The tool returned'))).toBe(true);

      const routines = runtime.listRoutines();
      const run = await runtime.runRoutine(routines[0].id);
      expect(run.status).toBe('success');
      expect(run.output).toContain('LOW');
    } finally {
      await runtime.dispose();
    }
  });

  it('keeps enterprise instructions locked and composes the branded persona', async () => {
    const { runtime } = await boot();
    await runtime.submitCredentials('ada', 'secret', '');
    const editor = runtime.getInstructions();
    expect(editor.enterpriseLocked).toBe(true);
    expect(editor.persona.persona).toContain('{{agentName}}');
    const saved = runtime.saveUserLayer({
      ...editor.user,
      communicationStyle: 'Use short sentences.',
    });
    expect(saved.user.communicationStyle).toContain('short sentences');
    const room = runtime.listRooms()[0];
    expect(room.agentIds.length).toBeGreaterThan(1);
    await runtime.sendRoomMessage(room.id, 'What should we watch for?');
    const transcript = runtime.openRoom(room.id);
    const authors = transcript.messages.filter((message) => message.role === 'assistant').map((message) => message.authorName);
    expect(authors).toContain('Northstar');
    expect(authors).toContain('Reviewer');
  });

  it('lists session and audience tokens and can re-exchange without returning the raw jwt', async () => {
    const { runtime } = await boot();
    await runtime.submitCredentials('ada', 'secret', '');
    const listed = await runtime.listInspectedTokens();
    const session = listed.find((item) => item.id === 'session');
    const exchanged = listed.find((item) => item.id === 'echo-local');
    expect(session).toMatchObject({ kind: 'session', aud: 'user', sub: 'mock:ada', present: true });
    expect(session?.scope).toContain('openid');
    expect(session?.header).toMatchObject({ alg: 'none', typ: 'mock' });
    expect(session?.iat).toEqual(expect.any(Number));
    expect(session?.expiresInMs).toBeGreaterThan(0);
    expect(exchanged).toMatchObject({
      kind: 'exchanged',
      audience: 'https://mcp.local.echo',
      aud: 'https://mcp.local.echo',
      scope: 'mcp:tools',
      sub: 'mock:ada',
    });
    const sessionJwt = await runtime.revealInspectedToken('session');
    const first = await runtime.revealInspectedToken('echo-local');
    expect(JSON.stringify(listed)).not.toContain(sessionJwt);
    expect(JSON.stringify(listed)).not.toContain(first);
    const refreshed = await runtime.reexchangeToken('echo-local');
    const second = await runtime.revealInspectedToken('echo-local');
    expect(second).not.toBe(first);
    expect(JSON.stringify(refreshed)).not.toContain(second);
    expect(refreshed.aud).toBe('https://mcp.local.echo');
  });

  it('stores the AI Agent secret from the environment and from settings', async () => {
    const secrets = new MemorySecretStore();
    const { runtime } = await boot(0, undefined, undefined, secrets, {
      PINGONE_AGENT_CLIENT_SECRET: 'agent-from-env',
      PINGONE_WORKER_CLIENT_SECRET: 'worker-from-env',
    });
    const view = await runtime.getSettingsAsync();
    expect(view.keys.agent).toBe(true);
    expect(view.keys.worker).toBe(true);
    expect(await secrets.get('agentClientSecret')).toBe('agent-from-env');
    const saved = await runtime.saveSettings({
      provider: view.provider,
      model: view.model,
      temperature: view.temperature,
      openaiBaseUrl: view.openaiBaseUrl,
      anthropicBaseUrl: view.anthropicBaseUrl,
      genericBaseUrl: view.genericBaseUrl,
      agentClientSecret: 'typed-agent',
    });
    expect(saved.keys.agent).toBe(true);
    expect(await secrets.get('agentClientSecret')).toBe('typed-agent');
  });

  it('puts an act claim on mock audience tokens when delegation is on', async () => {
    const { runtime } = await boot(0, (config) => {
      config.tokenExchange.delegation = true;
      config.tokenExchange.clientId = 'agent-id';
    });
    await runtime.submitCredentials('ada', 'secret', '');
    const exchanged = (await runtime.listInspectedTokens()).find((item) => item.id === 'echo-local');
    expect(exchanged?.act).toEqual({ sub: 'agent-id' });
  });

  it('hides token inspection when the admin flag is off', async () => {
    const { runtime } = await boot(0, (config) => {
      config.tokenExchange.inspectTokens = false;
    });
    await runtime.submitCredentials('ada', 'secret', '');
    expect((await runtime.getSettingsAsync()).tokenInspector).toBe(false);
    await expect(runtime.listInspectedTokens()).rejects.toThrow(/turned off/);
    await expect(runtime.revealInspectedToken('session')).rejects.toThrow(/turned off/);
  });
});

describe('pi.flow runtime', () => {
  function pingone(config: ReturnType<typeof parseEnterpriseConfig>): void {
    config.tenant.mode = 'pingone';
    config.tenant.authHost = 'https://auth.example';
    config.tenant.environmentId = 'env-1';
    config.tenant.clientId = 'client-1';
    config.protect.enabled = false;
  }

  it('signs in when the policy is identifier-first', async () => {
    let state = '';
    const posted: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      const type = headers.get('content-type') ?? '';
      if (type) posted.push(type);
      if (String(url).includes('/as/authorize')) {
        state = new URL(String(url)).searchParams.get('state') ?? '';
        return json(200, {
          id: 'flow-1',
          status: 'SIGN_ON_REQUIRED',
          _links: { 'user.lookup': { href: 'https://auth.example/env-1/flows/flow-1' } },
        });
      }
      if (type.includes('user.lookup')) {
        return json(200, {
          id: 'flow-1',
          status: 'PASSWORD_REQUIRED',
          _links: { 'usernamePassword.check': { href: 'https://auth.example/env-1/flows/flow-1' } },
        });
      }
      if (type.includes('usernamePassword.check')) {
        return json(200, {
          id: 'flow-1',
          status: 'COMPLETED',
          authorizeResponse: { code: 'auth-code', state },
          _embedded: { user: { id: 'user-1', username: 'ada' } },
        });
      }
      return json(200, { access_token: 'user-token', expires_in: 3600, token_type: 'Bearer' });
    };
    const { runtime } = await boot(0, pingone, fetchImpl);
    const signedIn = await runtime.submitCredentials('ada', 'secret', '');
    expect(signedIn.session?.username).toBe('ada');
    expect(posted).toEqual([
      'application/vnd.pingidentity.user.lookup+json',
      'application/vnd.pingidentity.usernamePassword.check+json',
      'application/x-www-form-urlencoded',
    ]);
  });

  it('reports an external identity provider instead of posting usernamePassword.check', async () => {
    const posted: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const type = new Headers(init?.headers).get('content-type');
      if (type) posted.push(type);
      if (String(url).includes('/as/authorize')) {
        return json(200, { id: 'flow-ext', status: 'EXTERNAL_AUTHENTICATION_REQUIRED', _links: {} });
      }
      return json(500, { message: 'unexpected' });
    };
    const { runtime } = await boot(0, pingone, fetchImpl);
    const state = await runtime.submitCredentials('ada', 'secret', '');
    expect(state.session).toBeNull();
    expect(state.login.phase).toBe('error');
    expect(state.login.message).toMatch(/external identity provider/);
    expect(posted).toEqual([]);
  });

  it('signs in with unknown risk when the public IP cannot be resolved', async () => {
    const events: { ip?: string }[] = [];
    const { runtime } = await boot(0, protectPatch, protectFetch({ events, ip: 'fail', riskStatus: 400 }), await workerSecrets());
    const signedIn = await runtime.submitCredentials('ada', 'secret', '');
    expect(signedIn.session?.username).toBe('ada');
    expect(signedIn.login.phase).not.toBe('blocked');
    expect(signedIn.risk?.level).toBe('UNKNOWN');
    expect(signedIn.risk?.action).toBe('restrict_tools');
    expect(signedIn.risk?.summary).toContain('Client IP unavailable');
    expect(events[0]?.ip).toBeUndefined();
  });

  it('sends the fallback public IP and keeps the Protect level', async () => {
    const events: { ip?: string }[] = [];
    const { runtime } = await boot(
      0,
      protectPatch,
      protectFetch({ events, ip: '203.0.113.8', riskStatus: 200 }),
      await workerSecrets(),
    );
    const signedIn = await runtime.submitCredentials('ada', 'secret', '');
    expect(signedIn.session?.username).toBe('ada');
    expect(signedIn.risk?.level).toBe('LOW');
    expect(signedIn.risk?.action).toBe('allow');
    expect(events[0]?.ip).toBe('203.0.113.8');
  });

  it('scores a sign-in without an IP when Protect accepts that event', async () => {
    const events: { ip?: string }[] = [];
    const { runtime } = await boot(0, protectPatch, protectFetch({ events, ip: 'fail', riskStatus: 200 }), await workerSecrets());
    const signedIn = await runtime.submitCredentials('ada', 'secret', '');
    expect(signedIn.risk?.level).toBe('LOW');
    expect(signedIn.session?.username).toBe('ada');
    expect(events[0]?.ip).toBeUndefined();
  });

  it('exchanges with the AI Agent client and keeps Protect on the worker', async () => {
    const grants = await captureGrants({ delegation: false });
    const exchanged = grants.filter((grant) => grant.grant.includes('token-exchange'));
    const credentials = grants.filter((grant) => grant.grant === 'client_credentials');
    expect(exchanged).toHaveLength(1);
    expect(exchanged[0]?.basic).toBe('agent-id:agent-secret');
    expect(exchanged[0]?.actor).toBeUndefined();
    expect(credentials.map((grant) => grant.basic)).toContain('worker-id:worker-secret');
    expect(credentials.some((grant) => grant.basic.startsWith('agent-id:'))).toBe(false);
  });

  it('falls back to the worker client when the AI Agent secret is absent', async () => {
    const grants = await captureGrants({ delegation: false, agentSecret: false });
    const exchanged = grants.filter((grant) => grant.grant.includes('token-exchange'));
    expect(exchanged).toHaveLength(1);
    expect(exchanged[0]?.basic).toBe('worker-id:worker-secret');
  });

  it('sends the AI Agent client-credentials token as actor_token when delegation is on', async () => {
    const grants = await captureGrants({ delegation: true });
    const exchanged = grants.find((grant) => grant.grant.includes('token-exchange'));
    const actor = grants.find((grant) => grant.grant === 'client_credentials' && grant.basic === 'agent-id:agent-secret');
    const worker = grants.find((grant) => grant.grant === 'client_credentials' && grant.basic === 'worker-id:worker-secret');
    expect(actor?.accessToken).toBe('agent-actor-token');
    expect(worker?.accessToken).toBe('worker-cc-token');
    expect(exchanged?.basic).toBe('agent-id:agent-secret');
    expect(exchanged?.actor).toBe('agent-actor-token');
  });
});

async function captureGrants(input: { delegation: boolean; agentSecret?: boolean }): Promise<TokenGrant[]> {
  const grants: TokenGrant[] = [];
  const secrets = new MemorySecretStore();
  await secrets.set('workerClientSecret', 'worker-secret');
  if (input.agentSecret !== false) await secrets.set('agentClientSecret', 'agent-secret');
  const { runtime } = await boot(
    0,
    (config) => {
      config.tenant.mode = 'pingone';
      config.tenant.authHost = 'https://auth.example';
      config.tenant.apiHost = 'https://api.example';
      config.tenant.environmentId = 'env-1';
      config.tenant.clientId = 'public-client';
      config.tokenExchange.clientId = 'agent-id';
      config.tokenExchange.delegation = input.delegation;
      config.tokenExchange.audiences = [{ id: 'echo', audience: 'https://mcp.example', scope: 'mcp:tools' }];
      config.protect.enabled = true;
      config.protect.reportedIp = '203.0.113.9';
      config.protect.resolvePublicIp = false;
    },
    tokenFetch(grants),
    secrets,
    { PINGONE_WORKER_CLIENT_ID: 'worker-id' },
  );
  const signedIn = await runtime.submitCredentials('ada', 'secret', '');
  expect(signedIn.session?.username).toBe('ada');
  return grants;
}

interface TokenGrant {
  grant: string;
  basic: string;
  actor?: string;
  accessToken: string;
}

function tokenFetch(grants: TokenGrant[]): typeof fetch {
  let state = '';
  return async (url, init) => {
    const target = String(url);
    const method = init?.method ?? 'GET';
    if (target.includes('/as/authorize')) {
      state = new URL(target).searchParams.get('state') ?? '';
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
        authorizeResponse: { code: 'auth-code', state },
        _embedded: { user: { id: 'user-1', username: 'ada' } },
      });
    }
    if (target.includes('/as/token')) {
      const body = new URLSearchParams(String(init?.body));
      const grant = body.get('grant_type') ?? '';
      const authorization = new Headers(init?.headers).get('authorization') ?? '';
      const basic = authorization.startsWith('Basic ')
        ? Buffer.from(authorization.slice(6), 'base64').toString('utf8')
        : '';
      const accessToken =
        grant === 'client_credentials'
          ? basic.startsWith('agent-id:')
            ? 'agent-actor-token'
            : 'worker-cc-token'
          : grant.includes('token-exchange')
            ? 'exchanged-token'
            : 'user-token';
      grants.push({ grant, basic, actor: body.get('actor_token') ?? undefined, accessToken });
      return json(200, { access_token: accessToken, expires_in: 3600, token_type: 'Bearer' });
    }
    if (target.includes('/riskEvaluations') && method === 'POST') {
      return json(200, { id: 'eval-1', result: { level: 'LOW' }, details: {} });
    }
    if (method === 'PUT') return new Response('', { status: 200 });
    return json(500, { message: target });
  };
}

function protectPatch(config: ReturnType<typeof parseEnterpriseConfig>): void {
  config.tenant.mode = 'pingone';
  config.tenant.authHost = 'https://auth.example';
  config.tenant.apiHost = 'https://api.example';
  config.tenant.environmentId = 'env-1';
  config.tenant.clientId = 'client-1';
  config.tokenExchange.clientId = 'worker';
  config.tokenExchange.audiences = [];
  config.protect.enabled = true;
  config.protect.resolvePublicIp = true;
  config.protect.reportedIp = '';
}

async function workerSecrets(): Promise<MemorySecretStore> {
  const secrets = new MemorySecretStore();
  await secrets.set('workerClientSecret', 'worker-secret');
  return secrets;
}

function protectFetch(input: { events: { ip?: string }[]; ip: 'fail' | string; riskStatus: number }): typeof fetch {
  let state = '';
  return async (url, init) => {
    const target = String(url);
    const method = init?.method ?? 'GET';
    if (target.includes('ipify')) throw new Error('timed out');
    if (target.includes('checkip.amazonaws.com')) {
      if (input.ip === 'fail') throw new Error('timed out');
      return new Response(`${input.ip}\n`, { status: 200 });
    }
    if (target.includes('/as/authorize')) {
      state = new URL(target).searchParams.get('state') ?? '';
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
        authorizeResponse: { code: 'auth-code', state },
        _embedded: { user: { id: 'user-1', username: 'ada' } },
      });
    }
    if (target.includes('/as/token')) {
      return json(200, { access_token: 'token', expires_in: 3600, token_type: 'Bearer' });
    }
    if (target.includes('/riskEvaluations') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { event?: { ip?: string } };
      input.events.push({ ip: body.event?.ip });
      if (input.riskStatus >= 400) return json(input.riskStatus, { message: 'ip is required' });
      return json(200, { id: 'eval-1', result: { level: 'LOW' }, details: {} });
    }
    if (method === 'PUT') return new Response('', { status: 200 });
    return json(500, { message: target });
  };
}

async function waitFor(events: ChatEvent[], predicate: (event: ChatEvent) => boolean): Promise<ChatEvent> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for an event.');
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
