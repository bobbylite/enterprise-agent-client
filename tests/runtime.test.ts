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

async function boot(delayMs = 0) {
  const rawBranding = JSON.parse(readFileSync('branding/default.json', 'utf8')) as Record<string, unknown>;
  const branding = parseBranding(
    { ...rawBranding, appName: 'Northstar', agentName: 'Northstar' },
    null,
  );
  const config = parseEnterpriseConfig(JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')));
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

async function waitFor(events: ChatEvent[], predicate: (event: ChatEvent) => boolean): Promise<ChatEvent> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for an event.');
}
