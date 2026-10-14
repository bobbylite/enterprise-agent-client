import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Repository } from '../src/main/db';
import { Runtime } from '../src/main/runtime';
import { parseBranding } from '../src/shared/branding';
import { parseEnterpriseConfig } from '../src/shared/config';
import { decodeJwtPayload, encodeJsonSegment } from '../src/shared/ids';
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
      const statuses = events.flatMap((event) => (event.type === 'tool' && event.tool.toolName === 'echo' ? [event.tool.status] : []));
      expect(statuses).toEqual(expect.arrayContaining(['calling', 'approval', 'running', 'done']));
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

  it('keeps the branding agent, moves routines onto it, and lets rooms pick from the agent list', async () => {
    const { runtime } = await boot();
    await runtime.submitCredentials('ada', 'secret', '');
    const branded = runtime.listAgents().find((agent) => agent.nameFromBranding);
    expect(branded?.name).toBe('Northstar');
    const page = runtime.openAgent(branded!.id);
    expect(page.enterpriseLocked).toBe(true);
    expect(page.enterprise.persona.length).toBeGreaterThan(0);
    expect(page.persona.persona).toContain('{{agentName}}');
    expect(page.skillIds).toEqual([]);
    expect(page.routines.map((routine) => routine.targetId)).toContain(branded!.id);
    expect(runtime.openAgent('reviewer').routines).toEqual([]);
    expect(runtime.openAgent('reviewer').persona.persona).toContain('reviewer');

    const created = runtime.saveAgent({
      name: 'Scribe',
      provider: 'mock',
      model: 'mock-1',
      persona: { ...page.persona, persona: 'You are the scribe.' },
      user: { ...page.user, communicationStyle: 'Be brief.' },
    });
    expect(created.profile.nameFromBranding).toBe(false);
    expect(created.skillIds).toEqual([]);
    const routine = runtime.saveRoutine({
      name: 'Scribe note',
      prompt: 'Write a note',
      agentId: created.profile.id,
      targetType: 'agent',
      targetId: created.profile.id,
      cron: '0 9 * * 1-5',
      enabled: false,
    });
    expect(runtime.openAgent(created.profile.id).routines.map((item) => item.id)).toContain(routine.id);
    const room = runtime.listRooms()[0];
    const savedRoom = runtime.saveRoom({
      id: room.id,
      name: room.name,
      instructions: room.instructions,
      agentIds: [...room.agentIds, created.profile.id],
    });
    expect(savedRoom.agentIds).toContain(created.profile.id);
    runtime.deleteAgent(created.profile.id);
    expect(runtime.listAgents().some((agent) => agent.id === created.profile.id)).toBe(false);
    expect(runtime.listRoutines().some((item) => item.id === routine.id)).toBe(false);
    expect(runtime.listRooms()[0].agentIds).not.toContain(created.profile.id);
    expect(() => runtime.deleteAgent(branded!.id)).toThrow(/branding agent/);
  });

  it('migrates global instructions and routines onto the branding agent', async () => {
    const rawBranding = JSON.parse(readFileSync('branding/default.json', 'utf8')) as Record<string, unknown>;
    const branding = parseBranding({ ...rawBranding, appName: 'Northstar', agentName: 'Northstar' }, null);
    const config = parseEnterpriseConfig(JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')));
    const db = Repository.open(':memory:');
    const fields = {
      persona: 'Migrated persona',
      communicationStyle: '',
      autonomy: '',
      safety: '',
      untrustedContent: '',
    };
    db.upsertAgent({
      id: 'default',
      name: 'Old name',
      provider: 'mock',
      model: 'mock-1',
      nameFromBranding: true,
      instructions: null,
      userInstructions: null,
      skillIds: [],
    });
    db.upsertAgent({
      id: 'reviewer',
      name: 'Reviewer',
      provider: 'mock',
      model: 'mock-1',
      nameFromBranding: false,
      instructions: { ...fields, persona: 'Stay the reviewer.' },
      userInstructions: null,
      skillIds: ['kept-skill'],
    });
    db.setInstructions('persona', fields);
    db.setInstructions('user', { ...fields, communicationStyle: 'Migrated style' });
    db.setSetting('personaCustomized', '1');
    db.setSetting('seeded', '1');
    db.upsertRoutine({
      id: 'legacy',
      name: 'Legacy',
      prompt: 'Do the legacy task',
      agentId: '',
      targetType: 'agent',
      targetId: 'default',
      cron: '0 9 * * 1-5',
      enabled: false,
      createdAt: 1,
      lastFiredMinute: null,
    });
    const runtime = await Runtime.create({
      config,
      branding,
      db,
      secrets: new MemorySecretStore(),
      appRoot: process.cwd(),
      attachmentsDir: mkdtempSync(join(tmpdir(), 'agent-')),
      encryptionAvailable: true,
      mockDelayMs: 0,
    });
    const page = runtime.openAgent('default');
    expect(page.profile.name).toBe('Northstar');
    expect(page.persona.persona).toBe('Migrated persona');
    expect(page.user.communicationStyle).toBe('Migrated style');
    expect(page.routines.map((routine) => routine.id)).toContain('legacy');
    expect(runtime.openAgent('reviewer').persona.persona).toBe('Stay the reviewer.');
    expect(runtime.openAgent('reviewer').skillIds).toEqual(['kept-skill']);
    expect(page.skillIds).toEqual([]);
    await runtime.dispose();
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

  it('runs each agent’s instructions, routines, and cron through the graph', async () => {
    const systems: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      systems.push(JSON.parse(String(init?.body)).system as string);
      return new Response(JSON.stringify({ content: 'Noted.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const { runtime } = await boot(
      0,
      (config) => {
        config.provider.default = 'generic';
        config.provider.genericBaseUrl = 'https://llm.example/generate';
      },
      fetchImpl,
    );
    try {
      await runtime.submitCredentials('ada', 'secret', '');
      const branded = runtime.listAgents().find((agent) => agent.nameFromBranding);
      expect(branded?.name).toBe('Northstar');
      const brandedPage = runtime.openAgent(branded!.id);
      runtime.saveAgent({
        id: branded!.id,
        name: branded!.name,
        provider: 'mock',
        model: 'mock-1',
        persona: brandedPage.persona,
        user: { ...brandedPage.user, communicationStyle: 'Branded user layer.' },
      });
      const reviewer = runtime.openAgent('reviewer');
      runtime.saveAgent({
        id: reviewer.profile.id,
        name: reviewer.profile.name,
        provider: 'mock',
        model: 'mock-1',
        persona: { ...reviewer.persona, persona: 'Reviewer persona only.' },
        user: { ...reviewer.user, communicationStyle: 'Reviewer user layer.' },
      });

      await runtime.sendRoomMessage(runtime.listRooms()[0].id, 'What should we watch for?');
      expect(systems).toHaveLength(2);
      const brandedTurn = systems.find((system) => system.includes('Branded user layer.'));
      const reviewerTurn = systems.find((system) => system.includes('Reviewer persona only.'));
      expect(brandedTurn).toBeTruthy();
      expect(brandedTurn).not.toContain('Reviewer user layer.');
      expect(brandedTurn).not.toContain('Reviewer persona only.');
      expect(reviewerTurn).toContain('Reviewer user layer.');
      expect(reviewerTurn).not.toContain('Branded user layer.');

      systems.length = 0;
      const routine = runtime.saveRoutine({
        name: 'Branded check',
        prompt: 'Check the branded agent only.',
        agentId: branded!.id,
        targetType: 'agent',
        targetId: branded!.id,
        cron: '0 9 * * 1-5',
        enabled: false,
      });
      const manual = await runtime.runRoutine(routine.id);
      expect(manual.status).toBe('success');
      expect(systems).toHaveLength(1);
      expect(systems[0]).toContain('Branded user layer.');
      expect(systems[0]).not.toContain('Reviewer user layer.');

      systems.length = 0;
      const cron = runtime.saveRoutine({
        name: 'Branded cron',
        prompt: 'Cron the branded agent.',
        agentId: branded!.id,
        targetType: 'agent',
        targetId: branded!.id,
        cron: '* * * * *',
        enabled: true,
      });
      const fired = await runtime.fireDueRoutines(new Date('2026-10-13T12:00:00Z'));
      expect(fired.map((item) => item.routineId)).toEqual([cron.id]);
      expect(fired[0]?.status).toBe('success');
      expect(systems).toHaveLength(1);
      expect(systems[0]).toContain('Branded user layer.');
      expect(systems[0]).not.toContain('Reviewer persona only.');
    } finally {
      await runtime.dispose();
    }
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

  it('keeps a partial answer when generation is stopped', async () => {
    const { runtime, events } = await boot(15);
    await runtime.submitCredentials('ada', 'secret', '');
    const snapshot = runtime.createConversation();
    const pending = runtime.sendMessage(snapshot.conversation.id, 'hello there friend', []);
    await waitFor(events, (event) => event.type === 'assistant-delta');
    runtime.stopGeneration(snapshot.conversation.id);
    await pending;
    const assistant = runtime.openConversation(snapshot.conversation.id).messages.find((message) => message.role === 'assistant');
    expect(assistant?.content.length).toBeGreaterThan(0);
    expect(assistant?.content).not.toContain('Ask me to');
    expect(assistant?.reasoning).toContain('Checking');
    expect(events.some((event) => event.type === 'assistant-phase' && event.phase === 'cancelled')).toBe(true);
  });

  it('hides reasoning when the admin flag is off', async () => {
    const { runtime, events } = await boot(0, (config) => {
      config.provider.showReasoning = false;
    });
    expect(runtime.state().showReasoning).toBe(false);
    await runtime.submitCredentials('ada', 'secret', '');
    const snapshot = runtime.createConversation();
    await runtime.sendMessage(snapshot.conversation.id, 'hello', []);
    expect(events.some((event) => event.type === 'assistant-reasoning')).toBe(false);
    const assistant = runtime.openConversation(snapshot.conversation.id).messages.find((message) => message.role === 'assistant');
    expect(assistant?.reasoning).toBe('');
  });

  it('streams each agent in a room and can clear that history', async () => {
    const { runtime, events } = await boot(0);
    await runtime.submitCredentials('ada', 'secret', '');
    const room = runtime.listRooms()[0];
    const routines = runtime.listRoutines().map((item) => item.id);
    await runtime.sendRoomMessage(room.id, 'hello room');
    const authors = events.flatMap((event) => (event.type === 'assistant-start' ? [event.authorName] : []));
    expect(authors).toEqual(expect.arrayContaining(['Northstar', 'Reviewer']));
    expect(runtime.openRoom(room.id).messages.length).toBeGreaterThan(1);
    runtime.deleteRoomHistory(room.id);
    expect(runtime.openRoom(room.id).messages).toEqual([]);
    expect(runtime.listRooms()[0]).toMatchObject({ id: room.id, agentIds: room.agentIds, instructions: room.instructions });
    expect(runtime.listRoutines().map((item) => item.id)).toEqual(routines);
  });

  it('deletes a chat, its tool results, and its attachment files', async () => {
    const { runtime, db } = await boot(0);
    await runtime.submitCredentials('ada', 'secret', '');
    const snapshot = runtime.createConversation();
    await runtime.sendMessage(snapshot.conversation.id, 'hello', []);
    const message = runtime.openConversation(snapshot.conversation.id).messages[0];
    const file = join(mkdtempSync(join(tmpdir(), 'attach-')), 'note.txt');
    writeFileSync(file, 'note');
    db.insertAttachment({
      id: 'att-1',
      messageId: message.id,
      name: 'note.txt',
      mime: 'text/plain',
      size: 4,
      path: file,
    });
    db.insertToolInvocation({
      id: 'tool-1',
      messageId: message.id,
      serverId: 'echo',
      serverName: 'Local echo',
      toolName: 'echo',
      args: { message: 'hello' },
      result: 'hello',
      status: 'done',
      approval: 'once',
    });
    runtime.deleteConversation(snapshot.conversation.id);
    expect(runtime.listConversations().some((item) => item.id === snapshot.conversation.id)).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(() => runtime.openConversation(snapshot.conversation.id)).toThrow(/not found/);
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

  it('lists the user token, the agent token, and an exchanged token that carries act', async () => {
    const { runtime } = await boot(0, (config) => {
      config.tokenExchange.clientId = 'agent-id';
    });
    await runtime.submitCredentials('ada', 'secret', '');
    const listed = await runtime.listInspectedTokens();
    const session = listed.find((item) => item.id === 'session');
    const agent = listed.find((item) => item.id === 'agent');
    const exchanged = listed.find((item) => item.id === 'echo-local');
    expect(listed.map((item) => item.kind)).toEqual(['session', 'agent', 'exchanged']);
    expect(session?.act).toBeNull();
    expect(agent).toMatchObject({ kind: 'agent', sub: 'agent-id', present: true, act: null });
    expect(exchanged?.act).toEqual({ sub: 'agent-id' });
    const agentJwt = await runtime.revealInspectedToken('agent');
    expect(JSON.stringify(listed)).not.toContain(agentJwt);
    const refreshed = await runtime.reexchangeToken('agent');
    expect(refreshed.kind).toBe('agent');
    expect(await runtime.revealInspectedToken('agent')).not.toBe(agentJwt);
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

describe('admin gate', () => {
  it('hides policy and the PingOne skill from a non-admin and allows them for an administrator', async () => {
    const { runtime } = await boot();
    const employee = await runtime.submitCredentials('ada', 'secret', '');
    expect(employee.session?.groups).toEqual(['Employees']);
    expect(employee.session?.admin).toBe(false);
    expect(employee.features.policyTab).toBe(false);
    expect(employee.features.pingoneTools).toBe(false);
    expect(employee.features.chat).toBe('allow');
    await expect(runtime.listPolicies()).rejects.toThrow(/Administrator/);
    await expect(runtime.scaffoldPolicies(true)).rejects.toThrow(/Administrator/);
    const branded = runtime.listAgents().find((agent) => agent.nameFromBranding);
    const employeePage = runtime.openAgent(branded!.id);
    expect(employeePage.skills.some((skill) => skill.id === 'pingone')).toBe(false);
    expect(() => runtime.assignSkill(branded!.id, 'pingone', true)).toThrow(/not found/);

    await runtime.logout();
    await runtime.setMockAdmin(true);
    const admin = await runtime.submitCredentials('ada', 'secret', '');
    expect(admin.session?.admin).toBe(true);
    expect(admin.session?.groups).toEqual(['Administrator']);
    expect(admin.features.policyTab).toBe(true);
    expect(admin.features.pingoneTools).toBe(true);
    const adminPage = runtime.openAgent(branded!.id);
    expect(adminPage.skills.some((skill) => skill.id === 'pingone' && skill.builtin && skill.requiresAdmin)).toBe(true);
    const assigned = runtime.assignSkill(branded!.id, 'pingone', true);
    expect(assigned.skillIds).toContain('pingone');
    expect(assigned.skills.find((skill) => skill.id === 'pingone')?.assigned).toBe(true);
  });

  it('scaffolds once, toggles enforcement, and audits both', async () => {
    const { runtime } = await boot();
    await runtime.setMockAdmin(true);
    await runtime.submitCredentials('ada', 'secret', '');
    const preview = await runtime.scaffoldPolicies(false);
    expect(preview.created).toEqual([]);
    expect(preview.policies).toEqual([]);
    expect(preview.preview.map((policy) => policy.id)).toEqual([
      'enterprise-agent:session',
      'enterprise-agent:admin',
      'enterprise-agent:read-only',
      'enterprise-agent:high-risk',
    ]);
    const created = await runtime.scaffoldPolicies(true);
    expect(created.created).toHaveLength(4);
    const again = await runtime.scaffoldPolicies(true);
    expect(again.created).toEqual([]);
    expect(await runtime.listPolicies()).toHaveLength(4);

    await runtime.setPolicyEnabled('enterprise-agent:session', false);
    const after = runtime.state();
    expect(after.features.chat).toBe('read_only');
    expect(after.features.mcpWrites).toBe(false);
    expect(after.features.policyTab).toBe(true);
    const audit = runtime.listAudit();
    expect(audit.some((event) => event.action === 'policy:scaffold' && event.username === 'ada')).toBe(true);
    expect(audit.some((event) => event.action === 'policy:enforcement' && event.detail.includes('disabled'))).toBe(true);
  });

  it('locks an administrator session down at high risk', async () => {
    const { runtime } = await boot(0, (config) => {
      config.protect.policy.levels.HIGH = 'allow';
      config.protect.policy.reasonOverrides = config.protect.policy.reasonOverrides.filter((item) => item.code !== 'IMPOSSIBLE_TRAVEL');
    });
    await runtime.setMockAdmin(true);
    await runtime.setMockScenario('impossible_travel');
    const state = await runtime.submitCredentials('ada', 'secret', '');
    expect(state.session?.admin).toBe(true);
    expect(state.risk?.level).toBe('HIGH');
    expect(state.risk?.action).toBe('allow');
    expect(state.features.policyTab).toBe(false);
    expect(state.features.pingoneTools).toBe(false);
    expect(state.features.mcpWrites).toBe(false);
    expect(state.features.chat).toBe('read_only');
    await expect(runtime.listPolicies()).rejects.toThrow(/Policy tab/);
    const snapshot = runtime.createConversation();
    await expect(runtime.sendMessage(snapshot.conversation.id, 'hello', [])).rejects.toThrow(/read-only/);
  });

  it('uses a worker token for the PingOne server and denies the tool until the skill is assigned', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pingone-token-'));
    const tokenFile = join(directory, 'token.txt');
    const script = join(directory, 'capture.mjs');
    writeFileSync(script, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], process.env.MCP_ACCESS_TOKEN ?? '');\n");
    const { runtime, events } = await boot();
    try {
      await runtime.setMockAdmin(false);
      await runtime.submitCredentials('ada', 'secret', '');
      await runtime.saveMcpServer({
        id: 'pingone',
        name: 'PingOne',
        transport: 'stdio',
        command: 'node',
        args: `${script} ${tokenFile}`,
        url: '',
        audience: '',
        scope: '',
        enabled: true,
      });
      await expect(runtime.connectMcp('pingone')).rejects.toThrow(/Administrator/);
      expect(existsSync(tokenFile)).toBe(false);

      await runtime.logout();
      await runtime.setMockAdmin(true);
      await runtime.submitCredentials('ada', 'secret', '');
      await expect(runtime.connectMcp('pingone')).rejects.toThrow();
      const payload = decodeJwtPayload(readFileSync(tokenFile, 'utf8'));
      expect(payload.aud).toBe('worker');
      expect(payload.sub).toBe('worker');
      expect(payload.act).toBeUndefined();

      await runtime.saveMcpServer({
        id: 'pingone',
        name: 'PingOne',
        transport: 'stdio',
        command: 'node',
        args: 'examples/echo-mcp-server.mjs',
        url: '',
        audience: '',
        scope: '',
        enabled: true,
      });
      const connected = await runtime.connectMcp('pingone');
      expect(connected.tools.map((tool) => tool.name)).toContain('echo');
      const branded = runtime.listAgents().find((agent) => agent.nameFromBranding);
      const snapshot = runtime.createConversation();
      await runtime.sendMessage(snapshot.conversation.id, 'echo hello', []);
      expect(events.some((event) => event.type === 'tool' && event.tool.serverId === 'pingone')).toBe(false);

      runtime.assignSkill(branded!.id, 'pingone', true);
      const pending = runtime.sendMessage(snapshot.conversation.id, 'echo hello again', []);
      const approval = await waitFor(events, (event) => event.type === 'approval-required' && event.request.serverId === 'pingone');
      if (approval.type !== 'approval-required') throw new Error('missing approval');
      runtime.respondApproval(approval.request.id, 'once');
      await pending;
      expect(events.some((event) => event.type === 'tool' && event.tool.serverId === 'pingone' && event.tool.status === 'done')).toBe(true);
      expect(runtime.listAudit().some((event) => event.action.startsWith('tool:pingone/') && event.agentId === branded!.id)).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it('injects the Authorize skill only for an admin who assigned it, and gates the reference tool', async () => {
    const systems: string[] = [];
    const toolLists: string[][] = [];
    let toolCall = 0;
    const { runtime, events } = await boot(0, undefined, async (url, init) => {
      if (!String(url).includes('llm.example')) return json(500, { message: String(url) });
      const body = JSON.parse(String(init?.body)) as {
        system?: string;
        tools?: {
          name: string;
          description?: string;
          inputSchema?: {
            required?: string[];
            additionalProperties?: boolean;
            properties?: { name?: { enum?: string[] } };
          };
        }[];
        messages?: { role: string; content?: string }[];
      };
      systems.push(body.system ?? '');
      toolLists.push((body.tools ?? []).map((tool) => tool.name));
      const skillTool = (body.tools ?? []).find((tool) => tool.name === 'skill__read_skill_reference');
      if (skillTool) {
        expect(skillTool.description).toContain('references/ea-api-operational-quirks.md');
        expect(skillTool.inputSchema?.required).toContain('name');
        expect(skillTool.inputSchema?.additionalProperties).toBe(false);
        expect(skillTool.inputSchema?.properties?.name?.enum).toContain('references/ea-api-operational-quirks.md');
      }
      const sawTool = (body.messages ?? []).some((message) => message.role === 'tool');
      const user = [...(body.messages ?? [])].reverse().find((message) => message.role === 'user');
      if (!sawTool && user?.content?.includes('read the authorize reference')) {
        return json(200, {
          content: '',
          tool_calls: [
            {
              id: `call-ref-${(toolCall += 1)}`,
              name: 'skill__read_skill_reference',
              arguments: JSON.stringify({ name: 'scripts/walk_policy_tree.py' }),
            },
          ],
        });
      }
      return json(200, { content: 'Noted.' });
    });
    try {
      const settings = runtime.getSettings();
      await runtime.saveSettings({
        provider: 'generic',
        model: 'generic-1',
        temperature: settings.temperature,
        openaiBaseUrl: settings.openaiBaseUrl,
        anthropicBaseUrl: settings.anthropicBaseUrl,
        genericBaseUrl: 'https://llm.example/generate',
      });
      await runtime.submitCredentials('ada', 'secret', '');
      const branded = runtime.listAgents().find((agent) => agent.nameFromBranding);
      const employeeChat = runtime.createConversation();
      await runtime.sendMessage(employeeChat.conversation.id, 'read the authorize reference', []);
      expect(systems.at(-1) ?? '').not.toContain('EA Admin API Build');
      expect(systems.at(-1) ?? '').not.toContain('Rate limiting is silent');
      expect(toolLists.at(-1) ?? []).not.toContain('skill__read_skill_reference');
      expect(
        events.some(
          (event) =>
            event.type === 'tool' && event.tool.status === 'denied' && event.tool.result === 'That tool is not connected.',
        ),
      ).toBe(true);

      await runtime.logout();
      await runtime.setMockAdmin(true);
      await runtime.submitCredentials('ada', 'secret', '');
      const adminChat = runtime.createConversation();
      await runtime.sendMessage(adminChat.conversation.id, 'hello', []);
      expect(systems.at(-1) ?? '').not.toContain('EA Admin API Build');
      expect(toolLists.at(-1) ?? []).not.toContain('skill__read_skill_reference');

      runtime.assignSkill(branded!.id, 'pingone', true);
      const pending = runtime.sendMessage(adminChat.conversation.id, 'read the authorize reference', []);
      const approval = await waitFor(
        events,
        (event) => event.type === 'approval-required' && event.request.toolName === 'read_skill_reference',
      );
      if (approval.type !== 'approval-required') throw new Error('missing approval');
      expect(approval.request.readOnlyHint).toBe(true);
      runtime.respondApproval(approval.request.id, 'once');
      await pending;
      const injected = systems.filter((system) => system.includes('EA Admin API Build'));
      expect(injected.length).toBeGreaterThan(0);
      expect(injected.every((system) => system.includes('Before any PingOne MCP tool call'))).toBe(true);
      expect(injected.every((system) => !system.includes('Rate limiting is silent'))).toBe(true);
      expect(toolLists.some((names) => names.includes('skill__read_skill_reference'))).toBe(true);
      const done = events.find(
        (event) => event.type === 'tool' && event.tool.toolName === 'read_skill_reference' && event.tool.status === 'done',
      );
      expect(done?.type === 'tool' ? done.tool.result : '').toContain('#!/usr/bin/env python3');
      expect(done?.type === 'tool' ? done.tool.result : '').not.toContain('Rate limiting is silent');
    } finally {
      await runtime.dispose();
    }
  });

  it('returns the valid reference names when the skill tool is called with {}', async () => {
    const { runtime, events } = await boot(0, undefined, async (url, init) => {
      if (!String(url).includes('llm.example')) return json(500, { message: String(url) });
      const body = JSON.parse(String(init?.body)) as { messages?: { role: string; content?: string }[] };
      const sawTool = (body.messages ?? []).some((message) => message.role === 'tool');
      const user = [...(body.messages ?? [])].reverse().find((message) => message.role === 'user');
      if (!sawTool && user?.content?.includes('read the authorize reference')) {
        return json(200, {
          content: '',
          tool_calls: [{ id: 'call-empty', name: 'skill__read_skill_reference', arguments: '{}' }],
        });
      }
      return json(200, { content: 'Noted.' });
    });
    try {
      const settings = runtime.getSettings();
      await runtime.saveSettings({
        provider: 'generic',
        model: 'generic-1',
        temperature: settings.temperature,
        openaiBaseUrl: settings.openaiBaseUrl,
        anthropicBaseUrl: settings.anthropicBaseUrl,
        genericBaseUrl: 'https://llm.example/generate',
      });
      await runtime.setMockAdmin(true);
      await runtime.submitCredentials('ada', 'secret', '');
      const branded = runtime.listAgents().find((agent) => agent.nameFromBranding);
      runtime.assignSkill(branded!.id, 'pingone', true);
      const snapshot = runtime.createConversation();
      const pending = runtime.sendMessage(snapshot.conversation.id, 'read the authorize reference', []);
      const approval = await waitFor(
        events,
        (event) => event.type === 'approval-required' && event.request.toolName === 'read_skill_reference',
      );
      if (approval.type !== 'approval-required') throw new Error('missing approval');
      runtime.respondApproval(approval.request.id, 'once');
      await pending;
      const failed = events.find(
        (event) => event.type === 'tool' && event.tool.toolName === 'read_skill_reference' && event.tool.status === 'error',
      );
      const result = failed?.type === 'tool' ? failed.tool.result ?? '' : '';
      expect(result).toMatch(/not found/);
      expect(result).toContain('Valid names:');
      expect(result).toContain('references/ea-api-operational-quirks.md');
      expect(result).toContain('scripts/walk_policy_tree.py');
    } finally {
      await runtime.dispose();
    }
  });

  it('hides a skill whose required groups do not match the session', async () => {
    const { runtime } = await boot();
    await runtime.submitCredentials('ada', 'secret', '');
    const uploaded = runtime.importSkill({
      name: 'Finance close',
      description: 'Books',
      instructions: 'Reconcile the books.',
      requiredGroups: ['Finance'],
    });
    expect(runtime.listSkills().some((skill) => skill.id === uploaded.id)).toBe(false);
    const branded = runtime.listAgents().find((agent) => agent.nameFromBranding);
    expect(runtime.openAgent(branded!.id).skills.some((skill) => skill.id === uploaded.id)).toBe(false);
    expect(() => runtime.deleteSkill('pingone')).toThrow(/not found/);
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

  it('reads the Administrator group from the access token', async () => {
    const { runtime } = await boot(
      0,
      (config) => {
        pingone(config);
        config.protect.enabled = false;
      },
      flowFetch(unsignedJwt({ sub: 'user-1', groups: ['Administrator'] })),
    );
    const state = await runtime.submitCredentials('ada', 'secret', '');
    expect(state.session?.admin).toBe(true);
    expect(state.session?.groups).toEqual(['Administrator']);
    expect(state.features.policyTab).toBe(true);
    expect(state.features.source).toBe('starter');
  });

  it('fails closed when the Authorize decision endpoint cannot be reached', async () => {
    let decisionAuth = '';
    const secrets = new MemorySecretStore();
    await secrets.set('workerClientSecret', 'worker-secret');
    const { runtime } = await boot(
      0,
      (config) => {
        pingone(config);
        config.protect.enabled = false;
        config.authorize.decisionEndpointId = 'decision-1';
      },
      async (url, init) => {
        const target = String(url);
        const body = String(init?.body ?? '');
        if (target.includes('/as/token') && body.includes('client_credentials')) {
          return json(200, { access_token: 'worker-token', expires_in: 3600, token_type: 'Bearer' });
        }
        if (target.includes('/decisionEndpoints/')) {
          decisionAuth = new Headers(init?.headers).get('authorization') ?? '';
          const parameters = (JSON.parse(body) as { parameters: Record<string, string> }).parameters;
          expect(parameters['user.groups']).toBe(JSON.stringify(['Administrator']));
          expect(parameters['risk.level']).toBe('LOW');
          expect(parameters['risk.score']).toBe('10');
          expect(parameters['risk.action']).toBe('allow');
          throw new Error('Authorize unreachable');
        }
        return flowFetch(unsignedJwt({ sub: 'user-1', groups: ['Administrator'] }))(url, init);
      },
      secrets,
      { PINGONE_WORKER_CLIENT_ID: 'worker-id' },
    );
    const state = await runtime.submitCredentials('ada', 'secret', '');
    expect(decisionAuth).toBe('Bearer worker-token');
    expect(state.features.source).toBe('fail_closed');
    expect(state.features.policyTab).toBe(false);
    expect(state.features.pingoneTools).toBe(false);
    expect(state.features.mcpWrites).toBe(false);
    expect(state.features.chat).toBe('read_only');
  });

  it('applies an Authorize feature statement from the worker decision call', async () => {
    const secrets = new MemorySecretStore();
    await secrets.set('workerClientSecret', 'worker-secret');
    const { runtime } = await boot(
      0,
      (config) => {
        pingone(config);
        config.protect.enabled = false;
        config.authorize.decisionEndpointId = 'decision-1';
      },
      async (url, init) => {
        const target = String(url);
        const body = String(init?.body ?? '');
        if (target.includes('/as/token') && body.includes('client_credentials')) {
          return json(200, { access_token: 'worker-token', expires_in: 3600, token_type: 'Bearer' });
        }
        if (target.includes('/decisionEndpoints/')) {
          return json(200, {
            decision: 'PERMIT',
            statements: [
              {
                code: 'enterprise-agent-features',
                payload: JSON.stringify({ policyTab: true, pingoneTools: false, mcpWrites: true, chat: 'allow' }),
              },
            ],
          });
        }
        return flowFetch(unsignedJwt({ sub: 'user-1', groups: ['Administrator'] }))(url, init);
      },
      secrets,
      { PINGONE_WORKER_CLIENT_ID: 'worker-id' },
    );
    const state = await runtime.submitCredentials('ada', 'secret', '');
    expect(state.features.source).toBe('authorize');
    expect(state.features.policyTab).toBe(true);
    expect(state.features.pingoneTools).toBe(false);
    expect(state.features.mcpWrites).toBe(true);
    expect(state.features.chat).toBe('allow');
    await runtime.saveMcpServer({
      id: 'pingone',
      name: 'PingOne',
      transport: 'stdio',
      command: 'node',
      args: 'examples/echo-mcp-server.mjs',
      url: '',
      audience: '',
      scope: '',
      enabled: true,
    });
    await expect(runtime.connectMcp('pingone')).rejects.toThrow(/turned PingOne tools off/);
  });

  it('retries a rate-limited scaffold and does not create the same policies again', async () => {
    const remote: { id: string; name: string; description: string; enabled: boolean }[] = [];
    const posts: string[] = [];
    let limited = true;
    const secrets = new MemorySecretStore();
    await secrets.set('workerClientSecret', 'worker-secret');
    const { runtime } = await boot(
      0,
      (config) => {
        pingone(config);
        config.protect.enabled = false;
      },
      async (url, init) => {
        const target = String(url);
        const method = init?.method ?? 'GET';
        const bodyText = String(init?.body ?? '');
        if (target.includes('/authorizationPolicies') && method === 'GET') {
          return json(200, { _embedded: { authorizationPolicies: remote } });
        }
        if (target.includes('/authorizationPolicies') && method === 'POST') {
          const body = JSON.parse(bodyText) as { name: string; description: string };
          if (limited) {
            limited = false;
            return new Response(JSON.stringify({ code: 'REQUEST_LIMITED' }), {
              status: 429,
              headers: { 'content-type': 'application/json', 'retry-after': '0' },
            });
          }
          if (remote.some((item) => item.name === body.name)) return json(409, { message: 'duplicate' });
          const id = `policy-${remote.length + 1}`;
          remote.push({ id, name: body.name, description: body.description, enabled: true });
          posts.push(body.name);
          return json(201, { id });
        }
        if (target.includes('/as/token') && bodyText.includes('client_credentials')) {
          return json(200, { access_token: 'worker-token', expires_in: 3600, token_type: 'Bearer' });
        }
        return flowFetch(unsignedJwt({ sub: 'user-1', groups: ['Administrator'] }))(url, init);
      },
      secrets,
      { PINGONE_WORKER_CLIENT_ID: 'worker-id' },
    );
    await runtime.submitCredentials('ada', 'secret', '');
    const [first, overlapping] = await Promise.all([runtime.scaffoldPolicies(true), runtime.scaffoldPolicies(true)]);
    expect(posts).toHaveLength(4);
    expect(first.created.length + overlapping.created.length).toBe(4);
    const again = await runtime.scaffoldPolicies(true);
    expect(again.created).toEqual([]);
    expect(posts).toHaveLength(4);
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

  it('exchanges every audience with one cached AI Agent token as actor_token', async () => {
    const grants = await captureGrants({ audiences: 2 });
    const exchanged = grants.filter((grant) => grant.grant.includes('token-exchange'));
    const agentCalls = grants.filter((grant) => grant.grant === 'client_credentials' && grant.basic === 'agent-id:agent-secret');
    const workerCalls = grants.filter((grant) => grant.grant === 'client_credentials' && grant.basic === 'worker-id:worker-secret');
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]?.accessToken).toBe('agent-actor-token');
    expect(workerCalls.length).toBeGreaterThan(0);
    expect(exchanged).toHaveLength(2);
    for (const grant of exchanged) {
      expect(grant.basic).toBe('agent-id:agent-secret');
      expect(grant.subject).toBe('user-token');
      expect(grant.subjectType).toBe('urn:ietf:params:oauth:token-type:access_token');
      expect(grant.actor).toBe('agent-actor-token');
      expect(grant.actorType).toBe('urn:ietf:params:oauth:token-type:access_token');
    }
  });

  it('falls back to the worker client when the AI Agent secret is absent', async () => {
    const grants = await captureGrants({ agentSecret: false });
    const exchanged = grants.filter((grant) => grant.grant.includes('token-exchange'));
    expect(exchanged).toHaveLength(1);
    expect(exchanged[0]?.basic).toBe('worker-id:worker-secret');
    expect(exchanged[0]?.actor).toBe('worker-cc-token');
    expect(exchanged[0]?.subject).toBe('user-token');
  });
});

async function captureGrants(input: { agentSecret?: boolean; audiences?: number }): Promise<TokenGrant[]> {
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
      config.tokenExchange.audiences = Array.from({ length: input.audiences ?? 1 }, (_, index) => ({
        id: `echo-${index}`,
        audience: `https://mcp.example/${index}`,
        scope: 'mcp:tools',
      }));
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
  actorType?: string;
  subject?: string;
  subjectType?: string;
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
      grants.push({
        grant,
        basic,
        actor: body.get('actor_token') ?? undefined,
        actorType: body.get('actor_token_type') ?? undefined,
        subject: body.get('subject_token') ?? undefined,
        subjectType: body.get('subject_token_type') ?? undefined,
        accessToken,
      });
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

function unsignedJwt(claims: Record<string, unknown>): string {
  return `${encodeJsonSegment({ alg: 'none', typ: 'JWT' })}.${encodeJsonSegment(claims)}.sig`;
}

function flowFetch(accessToken: string): typeof fetch {
  let state = '';
  return async (url, init) => {
    const type = new Headers(init?.headers).get('content-type') ?? '';
    const target = String(url);
    if (target.includes('/as/authorize')) {
      state = new URL(target).searchParams.get('state') ?? '';
      return json(200, {
        id: 'flow-1',
        status: 'USERNAME_PASSWORD_REQUIRED',
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
    if (target.includes('/as/token')) {
      return json(200, { access_token: accessToken, expires_in: 3600, token_type: 'Bearer' });
    }
    return json(500, { message: target });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
