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
    secrets: new MemorySecretStore(),
    appRoot: process.cwd(),
    attachmentsDir: mkdtempSync(join(tmpdir(), 'agent-')),
    encryptionAvailable: true,
    mockDelayMs: delayMs,
    emit: (event) => events.push(event),
    fetchImpl,
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
});

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
