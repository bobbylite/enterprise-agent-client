import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  BaseCheckpointSaver,
  TASKS,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  copyCheckpoint,
  maxChannelVersion,
  writesSortKey,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';

/**
 * LangGraph checkpointer on Node's built-in SQLite.
 * The published `@langchain/langgraph-checkpoint-sqlite` saver uses `better-sqlite3`,
 * whose native addon does not load in Electron (different NODE_MODULE_VERSION).
 * The SQL matches that saver so threads can pause on an approval and resume.
 */

interface WriteColumn {
  task_id: string;
  channel: string;
  type?: string;
  value?: string;
  task_path?: string;
  idx?: number;
}

function sortPendingWriteColumns(columns: WriteColumn[]): WriteColumn[] {
  return columns
    .map((column) => ({
      key: writesSortKey(column.task_path ?? '', column.task_id, column.idx ?? 0),
      column,
    }))
    .sort((left, right) => compareWritesSortKeys(left.key, right.key))
    .map(({ column }) => column);
}

function asText(value: SQLOutputValue): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value == null) return '';
  return String(value);
}

function asBytes(value: SQLOutputValue): Uint8Array | string {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function parseWrites(raw: SQLOutputValue): WriteColumn[] {
  const text = asText(raw);
  if (!text || text === 'null') return [];
  const parsed = JSON.parse(text) as WriteColumn[] | null;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((column) => column && column.task_id);
}

export class NodeSqliteSaver extends BaseCheckpointSaver {
  private readonly db: DatabaseSync;
  private ready = false;
  private readonly hasTaskPath = true;

  constructor(path: string) {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
  }

  close(): void {
    this.db.close();
  }

  private setup(): void {
    if (this.ready) return;
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec(`
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint BLOB,
  metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);`);
    this.db.exec(`
CREATE TABLE IF NOT EXISTS writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_path TEXT NOT NULL DEFAULT '',
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);`);
    this.ready = true;
  }

  private selectSql(checkpointId: boolean): string {
    const taskPath = this.hasTaskPath ? 'pw.task_path' : "''";
    return `
  SELECT
    thread_id,
    checkpoint_ns,
    checkpoint_id,
    parent_checkpoint_id,
    type,
    checkpoint,
    metadata,
    (
      SELECT json_group_array(
        json_object(
          'task_id', pw.task_id,
          'channel', pw.channel,
          'type', pw.type,
          'value', CAST(pw.value AS TEXT),
          'task_path', ${taskPath},
          'idx', pw.idx
        )
      )
      FROM writes as pw
      WHERE pw.thread_id = checkpoints.thread_id
        AND pw.checkpoint_ns = checkpoints.checkpoint_ns
        AND pw.checkpoint_id = checkpoints.checkpoint_id
    ) as pending_writes,
    (
      SELECT json_group_array(
        json_object(
          'type', ps.type,
          'value', CAST(ps.value AS TEXT)
        )
      )
      FROM writes as ps
      WHERE ps.thread_id = checkpoints.thread_id
        AND ps.checkpoint_ns = checkpoints.checkpoint_ns
        AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
        AND ps.channel = '${TASKS}'
      ORDER BY ps.idx
    ) as pending_sends
  FROM checkpoints
  WHERE thread_id = ? AND checkpoint_ns = ? ${checkpointId ? 'AND checkpoint_id = ?' : 'ORDER BY checkpoint_id DESC LIMIT 1'}`;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.setup();
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const checkpointId = config.configurable?.checkpoint_id;
    if (!threadId) return undefined;
    const args: string[] = [String(threadId), String(checkpointNs)];
    if (checkpointId) args.push(String(checkpointId));
    const row = this.db.prepare(this.selectSql(Boolean(checkpointId))).get(...args) as Record<string, SQLOutputValue> | undefined;
    if (!row) return undefined;
    return this.tupleFrom(row, String(checkpointNs));
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    this.setup();
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns;
    const { limit, before, filter } = options ?? {};
    const where: string[] = [];
    const args: SQLOutputValue[] = [];
    if (threadId) {
      where.push('thread_id = ?');
      args.push(String(threadId));
    }
    if (checkpointNs !== undefined && checkpointNs !== null) {
      where.push('checkpoint_ns = ?');
      args.push(String(checkpointNs));
    }
    if (before?.configurable?.checkpoint_id !== undefined) {
      where.push('checkpoint_id < ?');
      args.push(String(before.configurable.checkpoint_id));
    }
    const sanitized = Object.fromEntries(Object.entries(filter ?? {}).filter(([, value]) => value !== undefined));
    for (const [key, value] of Object.entries(sanitized)) {
      where.push('jsonb(CAST(metadata AS TEXT))->? = ?');
      args.push(`$.${key}`, JSON.stringify(value));
    }
    let sql = `
      SELECT
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        parent_checkpoint_id,
        type,
        checkpoint,
        metadata,
        (
          SELECT json_group_array(
            json_object(
              'task_id', pw.task_id,
              'channel', pw.channel,
              'type', pw.type,
              'value', CAST(pw.value AS TEXT),
              'task_path', pw.task_path,
              'idx', pw.idx
            )
          )
          FROM writes as pw
          WHERE pw.thread_id = checkpoints.thread_id
            AND pw.checkpoint_ns = checkpoints.checkpoint_ns
            AND pw.checkpoint_id = checkpoints.checkpoint_id
        ) as pending_writes
      FROM checkpoints`;
    if (where.length > 0) sql += `\nWHERE ${where.join(' AND ')}`;
    sql += '\nORDER BY checkpoint_id DESC';
    if (limit) sql += ` LIMIT ${Number.parseInt(String(limit), 10)}`;
    const rows = this.db.prepare(sql).all(...(args as (string | number | null | Uint8Array)[])) as Record<string, SQLOutputValue>[];
    for (const row of rows) yield await this.tupleFrom(row, asText(row.checkpoint_ns));
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    this.setup();
    const threadId = config.configurable?.thread_id;
    if (!threadId) throw new Error('Missing thread_id for the checkpoint.');
    const checkpointNs = String(config.configurable?.checkpoint_ns ?? '');
    const parent = config.configurable?.checkpoint_id ? String(config.configurable.checkpoint_id) : null;
    const prepared = copyCheckpoint(checkpoint);
    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(prepared),
      this.serde.dumpsTyped(metadata),
    ]);
    if (type1 !== type2) throw new Error('Checkpoint and metadata serialized to different types.');
    this.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(String(threadId), checkpointNs, checkpoint.id, parent, type1, serializedCheckpoint, serializedMetadata);
    return { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath = ''): Promise<void> {
    this.setup();
    const threadId = config.configurable?.thread_id;
    const checkpointId = config.configurable?.checkpoint_id;
    if (!threadId) throw new Error('Missing thread_id for checkpoint writes.');
    if (!checkpointId) throw new Error('Missing checkpoint_id for checkpoint writes.');
    const checkpointNs = String(config.configurable?.checkpoint_ns ?? '');
    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    const stmt = this.db.prepare(
      `INSERT ${allSpecial ? 'OR REPLACE' : 'OR IGNORE'} INTO writes
       (thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const rows = await Promise.all(
      writes.map(async (write, idx) => {
        const [type, serialized] = await this.serde.dumpsTyped(write[1]);
        const mapped = WRITES_IDX_MAP[write[0] as keyof typeof WRITES_IDX_MAP];
        return [
          String(threadId),
          checkpointNs,
          String(checkpointId),
          taskId,
          taskPath,
          mapped ?? idx,
          write[0],
          type,
          serialized,
        ] as const;
      }),
    );
    this.db.exec('BEGIN');
    try {
      for (const row of rows) stmt.run(...row);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    this.setup();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM checkpoints WHERE thread_id = ?').run(threadId);
      this.db.prepare('DELETE FROM writes WHERE thread_id = ?').run(threadId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private async tupleFrom(row: Record<string, SQLOutputValue>, checkpointNs: string): Promise<CheckpointTuple> {
    const threadId = asText(row.thread_id);
    const checkpointId = asText(row.checkpoint_id);
    const parentId = row.parent_checkpoint_id == null ? undefined : asText(row.parent_checkpoint_id);
    const pendingWrites = await Promise.all(
      sortPendingWriteColumns(parseWrites(row.pending_writes)).map(async (write) => [
        write.task_id,
        write.channel,
        await this.serde.loadsTyped(write.type ?? 'json', write.value ?? ''),
      ] as [string, string, unknown]),
    );
    const checkpoint = (await this.serde.loadsTyped(asText(row.type) || 'json', asBytes(row.checkpoint))) as Checkpoint;
    if (checkpoint.v < 4 && parentId) await this.migratePendingSends(checkpoint, threadId, parentId);
    return {
      config: { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpointId } },
      checkpoint,
      metadata: await this.serde.loadsTyped(asText(row.type) || 'json', asBytes(row.metadata)),
      parentConfig: parentId
        ? { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: parentId } }
        : undefined,
      pendingWrites,
    };
  }

  private async migratePendingSends(checkpoint: Checkpoint, threadId: string, parentCheckpointId: string): Promise<void> {
    const row = this.db
      .prepare(
        `SELECT json_group_array(json_object('type', ps.type, 'value', CAST(ps.value AS TEXT))) as pending_sends
         FROM writes as ps
         WHERE ps.thread_id = ? AND ps.checkpoint_id = ? AND ps.channel = ?
         ORDER BY ps.idx`,
      )
      .get(threadId, parentCheckpointId, TASKS) as Record<string, SQLOutputValue> | undefined;
    checkpoint.channel_values ??= {};
    checkpoint.channel_versions ??= {};
    const sends = JSON.parse(asText(row?.pending_sends ?? '[]') || '[]') as { type?: string; value?: string }[];
    checkpoint.channel_values[TASKS] = await Promise.all(
      (Array.isArray(sends) ? sends : []).map((send) => this.serde.loadsTyped(send.type ?? 'json', send.value ?? '')),
    );
    const versions = Object.values(checkpoint.channel_versions);
    checkpoint.channel_versions[TASKS] = versions.length > 0 ? maxChannelVersion(...versions) : this.getNextVersion(undefined);
  }
}

export function openCheckpointer(path: string): NodeSqliteSaver {
  return new NodeSqliteSaver(path);
}
