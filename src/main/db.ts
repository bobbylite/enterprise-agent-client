import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type {
  AgentProfile,
  Attachment,
  ChatMessage,
  Conversation,
  InstructionFields,
  ProviderId,
  Routine,
  RoutineRun,
  ToolInvocation,
} from '@shared/types';

export interface McpServerRow {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command: string;
  args: string[];
  url: string;
  audience: string;
  scope: string;
  enabled: boolean;
}

export interface RoutineRow extends Routine {
  lastFiredMinute: string | null;
}

export interface AgentRow extends AgentProfile {
  instructions: InstructionFields | null;
}

function text(value: SQLOutputValue | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function num(value: SQLOutputValue | undefined): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function bool(value: SQLOutputValue | undefined): boolean {
  return value === 1 || value === '1';
}

export class Repository {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  static open(path: string): Repository {
    return new Repository(new DatabaseSync(path));
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS secrets (
        account TEXT PRIMARY KEY,
        blob TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        agent_id TEXT,
        room_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        author_id TEXT,
        author_name TEXT,
        content TEXT NOT NULL,
        reasoning TEXT NOT NULL DEFAULT '',
        reasoning_ms INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_invocations (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        server_name TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        result_text TEXT,
        status TEXT NOT NULL,
        approval TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        transport TEXT NOT NULL,
        command TEXT,
        args_json TEXT,
        url TEXT,
        audience TEXT,
        scope TEXT,
        enabled INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_preferences (
        server_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        decision TEXT NOT NULL,
        PRIMARY KEY (server_id, tool_name)
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        instructions_json TEXT,
        name_from_branding INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        instructions TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_agents (
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        PRIMARY KEY (room_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        cron TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_fired_minute TEXT
      );
      CREATE TABLE IF NOT EXISTS routine_runs (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        output TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS instruction_layers (
        id TEXT PRIMARY KEY,
        fields_json TEXT NOT NULL
      );
    `);
    this.ensureColumn('messages', 'reasoning', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('messages', 'reasoning_ms', 'INTEGER');
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((row) => text(row.name) === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? text(row.value) : null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  getSecret(account: string): string | null {
    const row = this.db.prepare('SELECT blob FROM secrets WHERE account = ?').get(account);
    return row ? text(row.blob) : null;
  }

  setSecret(account: string, blob: string): void {
    this.db.prepare('INSERT INTO secrets(account, blob) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET blob = excluded.blob').run(account, blob);
  }

  deleteSecret(account: string): void {
    this.db.prepare('DELETE FROM secrets WHERE account = ?').run(account);
  }

  listConversations(): Conversation[] {
    return this.db
      .prepare('SELECT * FROM conversations ORDER BY updated_at DESC')
      .all()
      .map(mapConversation);
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    return row ? mapConversation(row) : null;
  }

  insertConversation(conversation: Conversation): void {
    this.db
      .prepare(
        'INSERT INTO conversations(id, title, kind, agent_id, room_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        conversation.id,
        conversation.title,
        conversation.kind,
        conversation.agentId,
        conversation.roomId,
        conversation.createdAt,
        conversation.updatedAt,
      );
  }

  touchConversation(id: string, updatedAt: number, title?: string): void {
    if (title) {
      this.db.prepare('UPDATE conversations SET updated_at = ?, title = ? WHERE id = ?').run(updatedAt, title, id);
    } else {
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(updatedAt, id);
    }
  }

  findRoomConversation(roomId: string): Conversation | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE room_id = ? AND kind = 'room'").get(roomId);
    return row ? mapConversation(row) : null;
  }

  listMessages(conversationId: string): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(conversationId);
    return rows.map((row) => {
      const id = text(row.id);
      return {
        id,
        conversationId: text(row.conversation_id),
        role: text(row.role) as ChatMessage['role'],
        authorId: row.author_id === null ? null : text(row.author_id),
        authorName: row.author_name === null ? null : text(row.author_name),
        content: text(row.content),
        reasoning: text(row.reasoning),
        reasoningMs: row.reasoning_ms === null || row.reasoning_ms === undefined ? null : num(row.reasoning_ms),
        createdAt: num(row.created_at),
        tools: this.listToolInvocations(id),
        attachments: this.listAttachments(id),
      };
    });
  }

  insertMessage(message: Omit<ChatMessage, 'tools' | 'attachments'>): void {
    this.db
      .prepare(
        'INSERT INTO messages(id, conversation_id, role, author_id, author_name, content, reasoning, reasoning_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        message.id,
        message.conversationId,
        message.role,
        message.authorId,
        message.authorName,
        message.content,
        message.reasoning ?? '',
        message.reasoningMs ?? null,
        message.createdAt,
      );
  }

  deleteConversation(id: string): string[] {
    const paths = this.attachmentPaths(id);
    this.clearMessages(id);
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return paths;
  }

  clearConversationMessages(id: string): string[] {
    const paths = this.attachmentPaths(id);
    this.clearMessages(id);
    return paths;
  }

  private attachmentPaths(conversationId: string): string[] {
    return this.db
      .prepare(
        'SELECT path FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)',
      )
      .all(conversationId)
      .map((row) => text(row.path))
      .filter(Boolean);
  }

  private clearMessages(conversationId: string): void {
    this.db
      .prepare('DELETE FROM tool_invocations WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)')
      .run(conversationId);
    this.db
      .prepare('DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)')
      .run(conversationId);
    this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
  }

  updateMessageContent(id: string, content: string): void {
    this.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id);
  }

  listToolInvocations(messageId: string): ToolInvocation[] {
    return this.db
      .prepare('SELECT * FROM tool_invocations WHERE message_id = ? ORDER BY created_at ASC')
      .all(messageId)
      .map((row) => ({
        id: text(row.id),
        messageId: text(row.message_id),
        serverId: text(row.server_id),
        serverName: text(row.server_name),
        toolName: text(row.tool_name),
        args: JSON.parse(text(row.args_json) || '{}') as unknown,
        result: row.result_text === null ? null : text(row.result_text),
        status: text(row.status) as ToolInvocation['status'],
        approval: row.approval === null ? null : (text(row.approval) as ToolInvocation['approval']),
      }));
  }

  insertToolInvocation(tool: ToolInvocation): void {
    this.db
      .prepare(
        `INSERT INTO tool_invocations(id, message_id, server_id, server_name, tool_name, args_json, result_text, status, approval, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tool.id,
        tool.messageId,
        tool.serverId,
        tool.serverName,
        tool.toolName,
        JSON.stringify(tool.args ?? {}),
        tool.result,
        tool.status,
        tool.approval,
        Date.now(),
      );
  }

  insertAttachment(attachment: Attachment & { path: string }): void {
    this.db
      .prepare('INSERT INTO attachments(id, message_id, name, mime, path, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(attachment.id, attachment.messageId, attachment.name, attachment.mime, attachment.path, attachment.size, Date.now());
  }

  linkAttachments(messageId: string, ids: string[]): void {
    const statement = this.db.prepare('UPDATE attachments SET message_id = ? WHERE id = ?');
    for (const id of ids) statement.run(messageId, id);
  }

  listAttachments(messageId: string): Attachment[] {
    return this.db
      .prepare('SELECT * FROM attachments WHERE message_id = ?')
      .all(messageId)
      .map(mapAttachment);
  }

  getAttachment(id: string): (Attachment & { path: string }) | null {
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
    if (!row) return null;
    return { ...mapAttachment(row), path: text(row.path) };
  }

  listMcpServers(): McpServerRow[] {
    return this.db
      .prepare('SELECT * FROM mcp_servers ORDER BY name')
      .all()
      .map((row) => ({
        id: text(row.id),
        name: text(row.name),
        transport: text(row.transport) as McpServerRow['transport'],
        command: text(row.command),
        args: JSON.parse(text(row.args_json) || '[]') as string[],
        url: text(row.url),
        audience: text(row.audience),
        scope: text(row.scope),
        enabled: bool(row.enabled),
      }));
  }

  upsertMcpServer(server: McpServerRow): void {
    this.db
      .prepare(
        `INSERT INTO mcp_servers(id, name, transport, command, args_json, url, audience, scope, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           transport = excluded.transport,
           command = excluded.command,
           args_json = excluded.args_json,
           url = excluded.url,
           audience = excluded.audience,
           scope = excluded.scope,
           enabled = excluded.enabled`,
      )
      .run(
        server.id,
        server.name,
        server.transport,
        server.command,
        JSON.stringify(server.args),
        server.url,
        server.audience,
        server.scope,
        server.enabled ? 1 : 0,
      );
  }

  deleteMcpServer(id: string): void {
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM tool_preferences WHERE server_id = ?').run(id);
  }

  getToolPreference(serverId: string, toolName: string): 'always' | 'deny' | null {
    const row = this.db
      .prepare('SELECT decision FROM tool_preferences WHERE server_id = ? AND tool_name = ?')
      .get(serverId, toolName);
    if (!row) return null;
    const decision = text(row.decision);
    return decision === 'always' || decision === 'deny' ? decision : null;
  }

  setToolPreference(serverId: string, toolName: string, decision: 'always' | 'deny'): void {
    this.db
      .prepare(
        `INSERT INTO tool_preferences(server_id, tool_name, decision) VALUES (?, ?, ?)
         ON CONFLICT(server_id, tool_name) DO UPDATE SET decision = excluded.decision`,
      )
      .run(serverId, toolName, decision);
  }

  listAgents(): AgentRow[] {
    return this.db.prepare('SELECT * FROM agents ORDER BY name').all().map(mapAgent);
  }

  getAgent(id: string): AgentRow | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
    return row ? mapAgent(row) : null;
  }

  upsertAgent(agent: AgentRow): void {
    this.db
      .prepare(
        `INSERT INTO agents(id, name, provider, model, instructions_json, name_from_branding)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           provider = excluded.provider,
           model = excluded.model,
           instructions_json = excluded.instructions_json,
           name_from_branding = excluded.name_from_branding`,
      )
      .run(
        agent.id,
        agent.name,
        agent.provider,
        agent.model,
        agent.instructions ? JSON.stringify(agent.instructions) : null,
        agent.nameFromBranding ? 1 : 0,
      );
  }

  listRooms(): { id: string; name: string; instructions: string; createdAt: number; agentIds: string[] }[] {
    return this.db
      .prepare('SELECT * FROM rooms ORDER BY name')
      .all()
      .map((row) => ({
        id: text(row.id),
        name: text(row.name),
        instructions: text(row.instructions),
        createdAt: num(row.created_at),
        agentIds: this.roomAgentIds(text(row.id)),
      }));
  }

  getRoom(id: string): { id: string; name: string; instructions: string; createdAt: number; agentIds: string[] } | null {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: text(row.id),
      name: text(row.name),
      instructions: text(row.instructions),
      createdAt: num(row.created_at),
      agentIds: this.roomAgentIds(id),
    };
  }

  upsertRoom(room: { id: string; name: string; instructions: string; createdAt: number; agentIds: string[] }): void {
    this.db
      .prepare(
        `INSERT INTO rooms(id, name, instructions, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, instructions = excluded.instructions`,
      )
      .run(room.id, room.name, room.instructions, room.createdAt);
    this.db.prepare('DELETE FROM room_agents WHERE room_id = ?').run(room.id);
    const insert = this.db.prepare('INSERT INTO room_agents(room_id, agent_id) VALUES (?, ?)');
    for (const agentId of room.agentIds) insert.run(room.id, agentId);
  }

  deleteRoom(id: string): void {
    this.db.prepare('DELETE FROM room_agents WHERE room_id = ?').run(id);
    this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  }

  private roomAgentIds(roomId: string): string[] {
    return this.db
      .prepare('SELECT agent_id FROM room_agents WHERE room_id = ?')
      .all(roomId)
      .map((row) => text(row.agent_id));
  }

  listRoutines(): RoutineRow[] {
    return this.db.prepare('SELECT * FROM routines ORDER BY name').all().map(mapRoutine);
  }

  getRoutine(id: string): RoutineRow | null {
    const row = this.db.prepare('SELECT * FROM routines WHERE id = ?').get(id);
    return row ? mapRoutine(row) : null;
  }

  upsertRoutine(routine: RoutineRow): void {
    this.db
      .prepare(
        `INSERT INTO routines(id, name, prompt, target_type, target_id, cron, enabled, created_at, last_fired_minute)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           prompt = excluded.prompt,
           target_type = excluded.target_type,
           target_id = excluded.target_id,
           cron = excluded.cron,
           enabled = excluded.enabled`,
      )
      .run(
        routine.id,
        routine.name,
        routine.prompt,
        routine.targetType,
        routine.targetId,
        routine.cron,
        routine.enabled ? 1 : 0,
        routine.createdAt,
        routine.lastFiredMinute,
      );
  }

  deleteRoutine(id: string): void {
    this.db.prepare('DELETE FROM routine_runs WHERE routine_id = ?').run(id);
    this.db.prepare('DELETE FROM routines WHERE id = ?').run(id);
  }

  markRoutineFired(id: string, minute: string): void {
    this.db.prepare('UPDATE routines SET last_fired_minute = ? WHERE id = ?').run(minute, id);
  }

  insertRun(run: RoutineRun): void {
    this.db
      .prepare(
        'INSERT INTO routine_runs(id, routine_id, started_at, finished_at, status, output, error) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(run.id, run.routineId, run.startedAt, run.finishedAt, run.status, run.output, run.error);
  }

  finishRun(id: string, patch: Pick<RoutineRun, 'finishedAt' | 'status' | 'output' | 'error'>): void {
    this.db
      .prepare('UPDATE routine_runs SET finished_at = ?, status = ?, output = ?, error = ? WHERE id = ?')
      .run(patch.finishedAt, patch.status, patch.output, patch.error, id);
  }

  listRuns(routineId: string): RoutineRun[] {
    return this.db
      .prepare('SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY started_at DESC')
      .all(routineId)
      .map(mapRun);
  }

  getInstructions(id: string): InstructionFields | null {
    const row = this.db.prepare('SELECT fields_json FROM instruction_layers WHERE id = ?').get(id);
    if (!row) return null;
    return JSON.parse(text(row.fields_json)) as InstructionFields;
  }

  setInstructions(id: string, fields: InstructionFields): void {
    this.db
      .prepare(
        `INSERT INTO instruction_layers(id, fields_json) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET fields_json = excluded.fields_json`,
      )
      .run(id, JSON.stringify(fields));
  }
}

function mapConversation(row: Record<string, SQLOutputValue>): Conversation {
  return {
    id: text(row.id),
    title: text(row.title),
    kind: text(row.kind) as Conversation['kind'],
    agentId: row.agent_id === null ? null : text(row.agent_id),
    roomId: row.room_id === null ? null : text(row.room_id),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function mapAttachment(row: Record<string, SQLOutputValue>): Attachment {
  return {
    id: text(row.id),
    messageId: row.message_id === null ? null : text(row.message_id),
    name: text(row.name),
    mime: text(row.mime),
    size: num(row.size),
  };
}

function mapAgent(row: Record<string, SQLOutputValue>): AgentRow {
  return {
    id: text(row.id),
    name: text(row.name),
    provider: text(row.provider) as ProviderId,
    model: text(row.model),
    nameFromBranding: bool(row.name_from_branding),
    instructions: row.instructions_json ? (JSON.parse(text(row.instructions_json)) as InstructionFields) : null,
  };
}

function mapRoutine(row: Record<string, SQLOutputValue>): RoutineRow {
  return {
    id: text(row.id),
    name: text(row.name),
    prompt: text(row.prompt),
    targetType: text(row.target_type) as Routine['targetType'],
    targetId: text(row.target_id),
    cron: text(row.cron),
    enabled: bool(row.enabled),
    createdAt: num(row.created_at),
    lastFiredMinute: row.last_fired_minute === null ? null : text(row.last_fired_minute),
  };
}

function mapRun(row: Record<string, SQLOutputValue>): RoutineRun {
  return {
    id: text(row.id),
    routineId: text(row.routine_id),
    startedAt: num(row.started_at),
    finishedAt: row.finished_at === null ? null : num(row.finished_at),
    status: text(row.status) as RoutineRun['status'],
    output: row.output === null ? null : text(row.output),
    error: row.error === null ? null : text(row.error),
  };
}
