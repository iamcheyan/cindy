/**
 * Headless 产品持久层。
 *
 * 与 benchmark 的 `SqliteSessionStorage` 分开：这里保存用户任务可见性、消息、
 * 待批准客户端与实时事件游标。运行时 SessionMeta 仍由 Maker 的 storage 合同
 * 管理；本模块只持久化产品数据与授权记录，不替代 Maker 内部恢复状态。
 *
 * 使用 Node 22 自带 `node:sqlite`。所有语句同步执行，调用方必须把本模块视为
 * server 单进程的串行状态机；异步边界之后重新核对 owner/client generation。
 */
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface TaskRecord {
  id: string;
  title: string;
  agentKind: string;
  model: string;
  provider: string;
  effort?: string;
  permissionMode: string;
  workspace: string;
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt: number;
}

export interface MessageRecord {
  seq: number;
  id: string;
  taskId: string;
  role: 'user' | 'assistant' | 'system';
  kind: string;
  content: string;
  clientId?: string;
  createdAt: number;
}

export interface ClientRecord {
  id: string;
  label: string;
  credentialHash: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export interface PendingClientRecord {
  /** SHA-256 of the browser's opaque requestId; never store that bearer value. */
  id: string;
  label: string;
  codeHash: string;
  createdAt: number;
  expiresAt: number;
  approvedAt: number | null;
  clientId?: string | null;
  redeemedAt?: number | null;
}

export interface EventRecord {
  seq: number;
  taskId: string;
  type: string;
  data: unknown;
  createdAt: number;
}

interface TaskRow {
  id: string;
  title: string;
  agent_kind: string;
  model: string;
  provider: string;
  effort: string | null;
  permission_mode: string;
  workspace: string;
  status: string;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  seq: number;
  id: string;
  task_id: string;
  role: string;
  kind: string;
  content: string;
  client_id: string | null;
  created_at: number;
}

interface ClientRow {
  id: string;
  label: string;
  credential_hash: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

interface PendingClientRow {
  id: string;
  label: string;
  code_hash: string;
  created_at: number;
  expires_at: number;
  approved_at: number | null;
  client_id: string | null;
  redeemed_at: number | null;
}

interface EventRow {
  seq: number;
  task_id: string;
  type: string;
  data: string;
  created_at: number;
}

function taskFromRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    agentKind: row.agent_kind,
    model: row.model,
    provider: row.provider,
    ...(row.effort ? { effort: row.effort } : {}),
    permissionMode: row.permission_mode,
    workspace: row.workspace,
    status: row.status === 'archived' ? 'archived' : 'active',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageFromRow(row: MessageRow): MessageRecord {
  return {
    seq: row.seq,
    id: row.id,
    taskId: row.task_id,
    role: row.role === 'user' || row.role === 'system' ? row.role : 'assistant',
    kind: row.kind,
    content: row.content,
    ...(row.client_id ? { clientId: row.client_id } : {}),
    createdAt: row.created_at,
  };
}

function clientFromRow(row: ClientRow): ClientRecord {
  return {
    id: row.id,
    label: row.label,
    credentialHash: row.credential_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

function pendingFromRow(row: PendingClientRow): PendingClientRecord {
  return {
    id: row.id,
    label: row.label,
    codeHash: row.code_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    clientId: row.client_id,
    redeemedAt: row.redeemed_at,
  };
}

export class HeadlessStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  static async open(dataDir: string): Promise<HeadlessStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(dataDir, 'cindy-server.sqlite');
    const store = new HeadlessStore(filePath);
    await chmod(dataDir, 0o700);
    await Promise.allSettled([filePath, `${filePath}-wal`, `${filePath}-shm`].map((file) => chmod(file, 0o600)));
    return store;
  }

  private migrate(): void {
    const schema = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (schema.user_version > 1) throw new Error('server database schema is newer than this Headless server');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS server_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        agent_kind TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        effort TEXT,
        permission_mode TEXT NOT NULL,
        workspace TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS server_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES server_tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        client_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS server_messages_task_seq ON server_messages(task_id, seq);
      CREATE TABLE IF NOT EXISTS server_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS server_events_task_seq ON server_events(task_id, seq);
      CREATE TABLE IF NOT EXISTS server_clients (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        credential_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS server_pending_clients (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        code_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        approved_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS server_sessions (
        token_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES server_clients(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS server_sessions_client ON server_sessions(client_id, revoked_at);
      CREATE TABLE IF NOT EXISTS server_requests (
        client_id TEXT NOT NULL REFERENCES server_clients(id) ON DELETE CASCADE,
        idempotency_key_hash TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES server_tasks(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('in_progress', 'accepted', 'rejected', 'unknown')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (client_id, idempotency_key_hash)
      );
      CREATE TABLE IF NOT EXISTS server_turns (
        task_id TEXT PRIMARY KEY REFERENCES server_tasks(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('idle', 'running', 'completed', 'failed', 'interrupted', 'unknown')),
        started_at INTEGER,
        ended_at INTEGER,
        request_id TEXT
      );
      CREATE TABLE IF NOT EXISTS server_interactions (
        request_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES server_tasks(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS server_interactions_task ON server_interactions(task_id);
      CREATE TABLE IF NOT EXISTS server_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const pendingColumns = this.db.prepare('PRAGMA table_info(server_pending_clients)').all() as Array<{ name: string }>;
    if (!pendingColumns.some((column) => column.name === 'client_id')) this.db.exec('ALTER TABLE server_pending_clients ADD COLUMN client_id TEXT');
    if (!pendingColumns.some((column) => column.name === 'redeemed_at')) this.db.exec('ALTER TABLE server_pending_clients ADD COLUMN redeemed_at INTEGER');
    this.db.exec('PRAGMA user_version = 1');
  }

  close(): void {
    this.db.close();
  }

  getSessionGrant(tokenHash: string): { clientId: string; expiresAt: number; revokedAt: number | null } | null {
    const row = this.db.prepare('SELECT client_id, expires_at, revoked_at FROM server_sessions WHERE token_hash = ?').get(tokenHash) as { client_id: string; expires_at: number; revoked_at: number | null } | undefined;
    return row ? { clientId: row.client_id, expiresAt: row.expires_at, revokedAt: row.revoked_at } : null;
  }

  revokeClientSessions(clientId: string): void {
    this.db.prepare('UPDATE server_sessions SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL').run(Date.now(), clientId);
  }

  revokeSession(tokenHash: string): void {
    this.db.prepare('UPDATE server_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(Date.now(), tokenHash);
  }

  eventCursor(taskId: string): number {
    const row = this.db.prepare('SELECT MAX(seq) AS cursor FROM server_events WHERE task_id = ?').get(taskId) as { cursor: number | null };
    return row.cursor ?? 0;
  }

  getTurn(taskId: string): { state: string; startedAt: number | null; endedAt: number | null; requestId: string | null } | null {
    const row = this.db.prepare('SELECT state, started_at, ended_at, request_id FROM server_turns WHERE task_id = ?').get(taskId) as { state: string; started_at: number | null; ended_at: number | null; request_id: string | null } | undefined;
    return row ? { state: row.state, startedAt: row.started_at, endedAt: row.ended_at, requestId: row.request_id } : null;
  }

  setTurn(taskId: string, state: string, requestId: string | null = null): void {
    const active = state === 'running';
    this.db.prepare(`INSERT INTO server_turns(task_id, state, started_at, ended_at, request_id)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET state = excluded.state,
      started_at = CASE WHEN excluded.state = 'running' THEN excluded.started_at ELSE server_turns.started_at END,
      ended_at = excluded.ended_at, request_id = excluded.request_id`)
      .run(taskId, state, active ? Date.now() : null, active ? null : Date.now(), requestId);
  }

  savePendingInteraction(taskId: string, requestId: string): void {
    this.db.prepare('INSERT OR REPLACE INTO server_interactions(request_id, task_id, created_at) VALUES (?, ?, ?)')
      .run(requestId, taskId, Date.now());
  }

  deletePendingInteraction(requestId: string): void {
    this.db.prepare('DELETE FROM server_interactions WHERE request_id = ?').run(requestId);
  }

  clearPendingInteractions(): Array<{ taskId: string; requestId: string }> {
    const rows = this.db.prepare('SELECT task_id, request_id FROM server_interactions').all() as Array<{ task_id: string; request_id: string }>;
    this.db.exec('DELETE FROM server_interactions');
    return rows.map((row) => ({ taskId: row.task_id, requestId: row.request_id }));
  }

  markRunningTurnsInterrupted(): string[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare("SELECT task_id FROM server_turns WHERE state = 'running'").all() as Array<{ task_id: string }>;
      this.db.prepare("UPDATE server_turns SET state = 'interrupted', ended_at = ? WHERE state = 'running'").run(Date.now());
      this.db.exec('COMMIT');
      return rows.map((row) => row.task_id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM server_meta WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO server_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  listTasks(): TaskRecord[] {
    const rows = this.db.prepare('SELECT * FROM server_tasks ORDER BY updated_at DESC, id DESC').all() as unknown as TaskRow[];
    return rows.map(taskFromRow);
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM server_tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  createTask(task: TaskRecord): TaskRecord {
    this.db.prepare(`
      INSERT INTO server_tasks(id, title, agent_kind, model, provider, effort, permission_mode, workspace, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.title,
      task.agentKind,
      task.model,
      task.provider,
      task.effort ?? null,
      task.permissionMode,
      task.workspace,
      task.status,
      task.createdAt,
      task.updatedAt,
    );
    return task;
  }

  updateTask(id: string, patch: Partial<Pick<TaskRecord, 'title' | 'status'>>): TaskRecord | null {
    const current = this.getTask(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.db.prepare('UPDATE server_tasks SET title = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(next.title, next.status, next.updatedAt, id);
    return next;
  }

  deleteTask(id: string): boolean {
    const result = this.db.prepare('DELETE FROM server_tasks WHERE id = ?').run(id);
    return result.changes === 1;
  }

  getRequest(clientId: string, keyHash: string): { bodyHash: string; taskId: string; messageId: string; state: string } | null {
    const row = this.db.prepare('SELECT body_hash, task_id, message_id, state FROM server_requests WHERE client_id = ? AND idempotency_key_hash = ?').get(clientId, keyHash) as { body_hash: string; task_id: string; message_id: string; state: string } | undefined;
    return row ? { bodyHash: row.body_hash, taskId: row.task_id, messageId: row.message_id, state: row.state } : null;
  }

  beginRequest(clientId: string, keyHash: string, bodyHash: string, taskId: string, messageId: string): boolean {
    this.db.prepare("DELETE FROM server_requests WHERE state != 'in_progress' AND created_at <= ?").run(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = this.db.prepare(`INSERT INTO server_requests(client_id, idempotency_key_hash, body_hash, task_id, message_id, state, created_at)
      VALUES (?, ?, ?, ?, ?, 'in_progress', ?) ON CONFLICT(client_id, idempotency_key_hash) DO NOTHING`)
      .run(clientId, keyHash, bodyHash, taskId, messageId, Date.now());
    return result.changes === 1;
  }

  setRequestState(clientId: string, keyHash: string, state: 'accepted' | 'rejected' | 'unknown'): void {
    this.db.prepare('UPDATE server_requests SET state = ? WHERE client_id = ? AND idempotency_key_hash = ?')
      .run(state, clientId, keyHash);
  }

  getMessageById(id: string): MessageRecord | null {
    const row = this.db.prepare('SELECT * FROM server_messages WHERE id = ?').get(id) as MessageRow | undefined;
    return row ? messageFromRow(row) : null;
  }

  deleteMessage(id: string): void {
    this.db.prepare('DELETE FROM server_messages WHERE id = ?').run(id);
  }

  appendMessage(input: Omit<MessageRecord, 'seq'>): MessageRecord {
    const result = this.db.prepare(`
      INSERT INTO server_messages(id, task_id, role, kind, content, client_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.taskId, input.role, input.kind, input.content, input.clientId ?? null, input.createdAt);
    return { ...input, seq: Number(result.lastInsertRowid) };
  }

  listMessages(taskId: string, afterSeq = 0, limit = 200): MessageRecord[] {
    const safeLimit = Math.min(Math.max(1, limit), 500);
    const rows = this.db.prepare('SELECT * FROM server_messages WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(taskId, afterSeq, safeLimit) as unknown as MessageRow[];
    return rows.map(messageFromRow);
  }

  appendEvent(taskId: string, type: string, data: unknown): EventRecord {
    const createdAt = Date.now();
    const result = this.db.prepare('INSERT INTO server_events(task_id, type, data, created_at) VALUES (?, ?, ?, ?)')
      .run(taskId, type, JSON.stringify(data ?? null), createdAt);
    return { seq: Number(result.lastInsertRowid), taskId, type, data, createdAt };
  }

  listEvents(taskId: string, afterSeq = 0, limit = 200): EventRecord[] {
    const safeLimit = Math.min(Math.max(1, limit), 500);
    const rows = this.db.prepare('SELECT * FROM server_events WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(taskId, afterSeq, safeLimit) as unknown as EventRow[];
    return rows.map((row) => ({ seq: row.seq, taskId: row.task_id, type: row.type, data: JSON.parse(row.data), createdAt: row.created_at }));
  }

  createPendingClient(input: PendingClientRecord): PendingClientRecord {
    const now = Date.now();
    this.db.prepare('DELETE FROM server_pending_clients WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM server_sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('INSERT INTO server_pending_clients(id, label, code_hash, created_at, expires_at, approved_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.id, input.label, input.codeHash, input.createdAt, input.expiresAt, input.approvedAt);
    return input;
  }

  listPendingClients(): PendingClientRecord[] {
    const rows = this.db.prepare('SELECT * FROM server_pending_clients WHERE approved_at IS NULL AND expires_at > ? ORDER BY created_at ASC')
      .all(Date.now()) as unknown as PendingClientRow[];
    return rows.map(pendingFromRow);
  }

  getPendingClient(id: string): PendingClientRecord | null {
    const row = this.db.prepare('SELECT * FROM server_pending_clients WHERE id = ?').get(id) as PendingClientRow | undefined;
    return row ? pendingFromRow(row) : null;
  }

  listAllPendingClients(): PendingClientRecord[] {
    const rows = this.db.prepare('SELECT * FROM server_pending_clients WHERE expires_at > ? ORDER BY created_at ASC').all(Date.now()) as unknown as PendingClientRow[];
    return rows.map(pendingFromRow);
  }

  approvePendingClient(id: string, clientId: string): PendingClientRecord | null {
    const pending = this.getPendingClient(id);
    if (!pending || pending.approvedAt !== null || pending.expiresAt <= Date.now()) return null;
    const approvedAt = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('UPDATE server_pending_clients SET approved_at = ?, client_id = ? WHERE id = ? AND approved_at IS NULL AND redeemed_at IS NULL AND expires_at > ?')
        .run(approvedAt, clientId, id, approvedAt);
      if (result.changes !== 1) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.db.prepare('INSERT INTO server_clients(id, label, credential_hash, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, NULL, NULL)')
        .run(clientId, pending.label, `pairing:${id}`, approvedAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { ...pending, approvedAt, clientId, redeemedAt: null };
  }

  redeemPendingClient(id: string, tokenHash: string, expiresAt: number): boolean {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pending = this.db.prepare('SELECT client_id FROM server_pending_clients WHERE id = ? AND approved_at IS NOT NULL AND redeemed_at IS NULL AND expires_at > ?')
        .get(id, now) as { client_id: string | null } | undefined;
      if (!pending?.client_id) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const result = this.db.prepare('UPDATE server_pending_clients SET redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL')
        .run(now, id);
      if (result.changes !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.prepare('INSERT INTO server_sessions(token_hash, client_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)')
        .run(tokenHash, pending.client_id, now, expiresAt);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deletePendingClient(id: string): void {
    this.db.prepare('DELETE FROM server_pending_clients WHERE id = ?').run(id);
  }

  createClient(input: ClientRecord): ClientRecord {
    this.db.prepare('INSERT INTO server_clients(id, label, credential_hash, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.id, input.label, input.credentialHash, input.createdAt, input.lastSeenAt, input.revokedAt);
    return input;
  }

  getClient(id: string): ClientRecord | null {
    const row = this.db.prepare('SELECT * FROM server_clients WHERE id = ?').get(id) as ClientRow | undefined;
    return row ? clientFromRow(row) : null;
  }

  getClientByCredentialHash(hash: string): ClientRecord | null {
    const row = this.db.prepare('SELECT * FROM server_clients WHERE credential_hash = ?').get(hash) as ClientRow | undefined;
    return row ? clientFromRow(row) : null;
  }

  listClients(): ClientRecord[] {
    const rows = this.db.prepare('SELECT * FROM server_clients ORDER BY created_at ASC').all() as unknown as ClientRow[];
    return rows.map(clientFromRow);
  }

  touchClient(id: string): void {
    this.db.prepare('UPDATE server_clients SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id);
  }

  revokeClient(id: string): ClientRecord | null {
    const client = this.getClient(id);
    if (!client) return null;
    const revokedAt = Date.now();
    this.db.prepare('UPDATE server_clients SET revoked_at = ? WHERE id = ?').run(revokedAt, id);
    return { ...client, revokedAt };
  }

  revokeAllClients(): number {
    const result = this.db.prepare('UPDATE server_clients SET revoked_at = ? WHERE revoked_at IS NULL').run(Date.now());
    return Number(result.changes);
  }
}
