/**
 * 测试价值
 * - 生产入口与可观察结果：真实 `ServerRuntime.createTask` 与 `createWebServer` + `HeadlessStore` loopback HTTP/SSE；
 *   覆盖创建期间任务不可见、配对轮询限速、cookie/CSRF、双客户端共享任务、实时消息、stop、interaction、revoke 与重启。
 * - Bug／规则依据：server v1 的创建原子性、认证、任务、SSE、interaction 与 revoke 语义。
 * - 现有覆盖缺口：task 创建可能早于 Maker Session 附着；配对状态轮询也缺少专用上限，不能只依赖普通 API 限速。
 * - 最小失败输入：第 121 次同 peer 配对状态轮询须返回 429；阻塞 `maker.createSession()` 时 task list 不含新 task；SSE 已连接后的新消息须实时到达。
 * - tier：unit（真实 loopback socket + 临时 SQLite；端口由 listen(0) 分配，临时目录清理）。
 * - 实测耗时：随 `pnpm --filter cindy-headless test` 运行。
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebServer, type WebServerHandle } from './http.js';
import { sha256, type ServerConfig } from './config.js';
import { HeadlessStore, type MessageRecord, type TaskRecord } from './store.js';
import { ServerRuntime, type PendingInteractionView } from './runtime.js';

type JsonResult = { status: number; body: Record<string, any>; cookie?: string; csrf?: string };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function cookieFrom(headers: Headers): string | undefined {
  const values = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const raw = values[0] ?? headers.get('set-cookie') ?? '';
  return raw ? raw.split(';')[0] : undefined;
}

function fakeRuntime(store: HeadlessStore, workspace: string): { runtime: ServerRuntime; interactions: PendingInteractionView[]; emit: (taskId: string, type: string, data: unknown) => void } {
  const interactions: PendingInteractionView[] = [];
  const listeners = new Set<(event: { taskId: string; event: any; record?: unknown }) => void>();
  const runtime = {
    store,
    startedAt: Date.now(),
    defaultWorkspace: workspace,
    resolvedProfile: {
      profile: {
        agentBackend: 'claude-code',
        model: { provider: 'test', requestedId: 'test-model' },
        permissionMode: 'default',
      },
    },
    onEvent(listener: (event: { taskId: string; event: any; record?: unknown }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listTasks: () => store.listTasks(),
    getTask: (id: string) => store.getTask(id),
    listMessages: (id: string, after = 0, limit = 200) => store.listMessages(id, after, limit),
    listEvents: (id: string, after = 0, limit = 200) => store.listEvents(id, after, limit),
    getEventCursor: (id: string) => store.eventCursor(id),
    getTurnState: (id: string) => store.getTurn(id)?.state ?? 'idle',
    getStreamingText: () => null,
    listInteractions: () => interactions,
    async createTask(input: { title?: string; workspace?: string }) {
      const now = Date.now();
      const task: TaskRecord = {
        id: randomUUID(),
        title: input.title ?? 'New task',
        agentKind: 'claude-code',
        model: 'test-model',
        provider: 'test',
        permissionMode: 'default',
        workspace: input.workspace ?? workspace,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      store.createTask(task);
      store.appendEvent(task.id, 'task:created', { task });
      return { task };
    },
    async sendMessage(taskId: string, content: string, clientId: string): Promise<MessageRecord> {
      const message = store.appendMessage({
        id: randomUUID(), taskId, role: 'user', kind: 'text', content, clientId, createdAt: Date.now(),
      });
      store.setTurn(taskId, 'running');
      const record = store.appendEvent(taskId, 'message:created', message);
      for (const listener of listeners) listener({ taskId, event: { type: 'status', data: { message } }, record });
      return message;
    },
    async stopTask(taskId: string) {
      store.setTurn(taskId, 'interrupted');
      const record = store.appendEvent(taskId, 'task:stopped', { state: 'interrupted' });
      for (const listener of listeners) listener({ taskId, event: { type: 'status', data: { status: 'interrupted' } }, record });
    },
    async updateTask(id: string, patch: Partial<Pick<TaskRecord, 'title' | 'status'>>) {
      return store.updateTask(id, patch);
    },
    resolveInteraction: () => true,
    async close() {},
  } as unknown as ServerRuntime;
  const emit = (taskId: string, type: string, data: unknown) => {
    const record = store.appendEvent(taskId, type, data);
    for (const listener of listeners) listener({ taskId, event: { type: 'status', data: {} }, record });
  };
  return { runtime, interactions, emit };
}

async function startServer(store: HeadlessStore, dataDir: string, workspace: string): Promise<{ base: string; web: WebServerHandle; runtime: ServerRuntime; interactions: PendingInteractionView[]; emit: (taskId: string, type: string, data: unknown) => void }> {
  const { runtime, interactions, emit } = fakeRuntime(store, workspace);
  const config: ServerConfig = {
    version: 1,
    host: '127.0.0.1',
    port: 0,
    dataDir,
    webEnabled: true,
    workspaceRoot: workspace,
    taskDefaults: {
      agentBackend: 'claude-code',
      agentBinaryPath: '/bin/true',
      model: 'test-model',
      provider: 'test',
      permissionMode: 'default',
    },
  };
  const web = await createWebServer({ runtime, config, store });
  const address = web.server.address();
  if (!address || typeof address !== 'object') throw new Error('test server did not bind');
  return { base: `http://127.0.0.1:${address.port}`, web, runtime, interactions, emit };
}

async function call(base: string, method: string, pathname: string, options: { body?: unknown; cookie?: string; csrf?: string; idempotencyKey?: string } = {}): Promise<JsonResult> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.csrf) headers['X-Cindy-CSRF'] = options.csrf;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  if (method !== 'GET') headers.Origin = base;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as Record<string, any> : {};
  return { status: response.status, body, cookie: cookieFrom(response.headers), csrf: body.csrfToken };
}

async function pair(base: string, store: HeadlessStore, label: string): Promise<{ cookie: string; csrf: string; clientId: string }> {
  const requested = await call(base, 'POST', '/api/auth/requests', { body: { label } });
  expect(requested.status).toBe(201);
  const requestId = requested.body.requestId as string;
  const approved = store.approvePendingClient(sha256(requestId), randomUUID());
  expect(approved).not.toBeNull();
  const polled = await call(base, 'POST', '/api/auth/requests/status', { body: { requestId } });
  expect(polled.status).toBe(200);
  expect(polled.body.status).toBe('approved');
  expect(polled.cookie).toMatch(/^cindy_session=/);
  expect(polled.csrf).toEqual(expect.any(String));
  return {
    cookie: String(polled.cookie),
    csrf: polled.csrf!,
    clientId: polled.body.client.id as string,
  };
}

describe('headless web server contract', () => {
  it('sends Web-compatible interaction SSE payloads', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-headless-interaction-sse-'));
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'cindy-headless-interaction-workspace-'));
    const store = await HeadlessStore.open(dataDir);
    const server = await startServer(store, dataDir, workspace);
    cleanups.push(async () => { await server.web.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); });

    const client = await pair(server.base, store, 'interaction-sse-client');
    const created = await call(server.base, 'POST', '/api/tasks', { body: {}, cookie: client.cookie, csrf: client.csrf });
    const taskId = created.body.task.id as string;
    const controller = new AbortController();
    const sse = await fetch(`${server.base}/api/tasks/${taskId}/events?after=1`, {
      headers: { Cookie: client.cookie, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(sse.status).toBe(200);
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let streamed = '';
    const request = { kind: 'permission', requestId: 'interaction-sse-1', toolName: 'Bash', input: { command: 'pwd' } };
    try {
      while (!streamed.includes('event: ready')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        streamed += decoder.decode(chunk.value, { stream: true });
      }
      server.emit(taskId, 'interaction:request', { interaction: { request, createdAt: 1 } });
      server.emit(taskId, 'interaction:dismissed', { requestId: request.requestId });
      while (!streamed.includes('event: interaction-dismissed')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        streamed += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
    const lines = streamed.split('\n');
    const interactionIndex = lines.indexOf('event: interaction');
    expect(interactionIndex).toBeGreaterThanOrEqual(0);
    const dataLine = lines[interactionIndex + 1]!;
    expect(dataLine.startsWith('data: ')).toBe(true);
    expect(JSON.parse(dataLine.slice('data: '.length))).toEqual({ interaction: { request, createdAt: 1 } });
    const dismissedIndex = lines.indexOf('event: interaction-dismissed');
    expect(dismissedIndex).toBeGreaterThanOrEqual(0);
    const dismissedData = lines[dismissedIndex + 1]!;
    expect(JSON.parse(dismissedData.slice('data: '.length))).toEqual({ requestId: 'interaction-sse-1' });
  });

  it('rate limits pairing status polling per peer', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-headless-pair-rate-'));
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'cindy-headless-pair-rate-workspace-'));
    const store = await HeadlessStore.open(dataDir);
    const server = await startServer(store, dataDir, workspace);
    cleanups.push(async () => { await server.web.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); });

    const created = await call(server.base, 'POST', '/api/auth/requests', { body: { label: 'poll-limit-client' } });
    const requestId = created.body.requestId as string;
    for (let count = 0; count < 120; count += 1) {
      expect((await call(server.base, 'POST', '/api/auth/requests/status', { body: { requestId } })).status).toBe(200);
    }
    const limited = await call(server.base, 'POST', '/api/auth/requests/status', { body: { requestId } });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('does not expose a task before its Maker session is attached', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-headless-create-race-'));
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'cindy-headless-create-workspace-'));
    const store = await HeadlessStore.open(dataDir);
    const sessionStarted = Promise.withResolvers<void>();
    const sessionReady = Promise.withResolvers<(typeof sessionStub)>();
    const sessionStub = {
      setInteractionListener() {},
      onEvent: () => () => undefined,
      onStatusChange: () => () => undefined,
      async close() {},
    };
    const maker = {
      createSession: async () => {
        sessionStarted.resolve();
        return sessionReady.promise;
      },
      async getSessionMeta() { return null; },
      async shutdown() {},
    };
    const resolvedProfile = {
      profile: {
        agentBackend: 'claude-code',
        model: { provider: 'test', requestedId: 'test-model' },
        permissionMode: 'default',
      },
    };
    const RuntimeForTest = ServerRuntime as unknown as new (...args: any[]) => ServerRuntime;
    const runtime = new RuntimeForTest(store, resolvedProfile, maker, workspace, async () => undefined);
    const config: ServerConfig = {
      version: 1,
      host: '127.0.0.1',
      port: 0,
      dataDir,
      webEnabled: true,
      workspaceRoot: workspace,
      taskDefaults: {
        agentBackend: 'claude-code',
        agentBinaryPath: '/bin/true',
        model: 'test-model',
        provider: 'test',
        permissionMode: 'default',
      },
    };
    const web = await createWebServer({ runtime, config, store });
    const address = web.server.address();
    if (!address || typeof address !== 'object') throw new Error('test server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    cleanups.push(async () => {
      await web.close();
      await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    });

    const client = await pair(base, store, 'create-race-client');
    const creating = runtime.createTask({ title: 'Creating' }, client.clientId);
    await sessionStarted.promise;
    expect((await call(base, 'GET', '/api/tasks', { cookie: client.cookie })).body.tasks).toHaveLength(0);

    sessionReady.resolve(sessionStub);
    await creating;
    expect((await call(base, 'GET', '/api/tasks', { cookie: client.cookie })).body.tasks).toHaveLength(1);
  });

  it('pairs two clients, shares tasks, streams, resolves interactions, revokes one client, and survives restart', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-headless-server-test-'));
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'cindy-headless-workspace-test-'));
    cleanups.push(async () => { await rm(dataDir, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); });

    let store = await HeadlessStore.open(dataDir);
    let server = await startServer(store, dataDir, workspace);
    cleanups.push(async () => { await server.web.close(); store.close(); });

    expect((await call(server.base, 'GET', '/api/session')).status).toBe(401);
    const a = await pair(server.base, store, 'client-a');
    const b = await pair(server.base, store, 'client-b');

    const sessionA = await call(server.base, 'GET', '/api/session', { cookie: a.cookie });
    expect(sessionA.status).toBe(200);
    expect(sessionA.body.client.id).toBe(a.clientId);
    expect(sessionA.body.server.exposure.status).toBe('loopback-only');

    const denied = await call(server.base, 'POST', '/api/tasks', { body: {}, cookie: b.cookie });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('CSRF_FAILED');

    const created = await call(server.base, 'POST', '/api/tasks', { body: {}, cookie: b.cookie, csrf: b.csrf });
    expect(created.status).toBe(201);
    const taskId = created.body.task.id as string;

    const controller = new AbortController();
    const sse = await fetch(`${server.base}/api/tasks/${taskId}/events?after=1`, {
      headers: { Cookie: b.cookie, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(sse.status).toBe(200);
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let streamed = '';
    try {
      while (!streamed.includes('event: ready')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        streamed += decoder.decode(chunk.value, { stream: true });
      }

      const sent = await call(server.base, 'POST', `/api/tasks/${taskId}/messages`, {
        body: { content: 'hello from client a' },
        cookie: a.cookie,
        csrf: a.csrf,
        idempotencyKey: 'test-request-1',
      });
      expect(sent.status).toBe(201);
      expect(sent.body.message.role).toBe('user');

      while (!streamed.includes('event: message')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        streamed += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
    expect(streamed).toContain('event: ready');
    expect(streamed).toContain('event: message');
    expect(streamed).toContain('hello from client a');

    const seenByB = await call(server.base, 'GET', `/api/tasks/${taskId}`, { cookie: b.cookie });
    expect(seenByB.status).toBe(200);
    expect(seenByB.body.task.turnState).toBe('running');
    expect(seenByB.body.running).toBe(true);
    expect(seenByB.body.messages.map((message: MessageRecord) => message.content)).toContain('hello from client a');

    // Pending card is visible in the snapshot and can be resolved once.
    server.interactions.push({
      request: { kind: 'permission', requestId: 'interaction-test-1', toolName: 'Bash', input: { command: 'pwd' } },
      createdAt: Date.now(),
    });
    const withCard = await call(server.base, 'GET', `/api/tasks/${taskId}`, { cookie: a.cookie });
    expect(withCard.body.interactions).toHaveLength(1);
    const resolved = await call(server.base, 'POST', `/api/tasks/${taskId}/interactions/interaction-test-1`, {
      body: { decision: { kind: 'permission', behavior: 'allow', scope: 'session' } },
      cookie: a.cookie,
      csrf: a.csrf,
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.accepted).toBe(true);

    const stopped = await call(server.base, 'POST', `/api/tasks/${taskId}/stop`, { cookie: b.cookie, csrf: b.csrf });
    expect(stopped.status).toBe(200);
    expect((await call(server.base, 'GET', `/api/tasks/${taskId}`, { cookie: b.cookie })).body.task.turnState).toBe('interrupted');

    store.revokeClient(a.clientId);
    store.revokeClientSessions(a.clientId);
    expect((await call(server.base, 'GET', '/api/session', { cookie: a.cookie })).status).toBe(401);
    expect((await call(server.base, 'GET', '/api/session', { cookie: b.cookie })).status).toBe(200);

    // Restart: B's grant and task history survive; A remains revoked.
    await server.web.close();
    store.close();
    store = await HeadlessStore.open(dataDir);
    server = await startServer(store, dataDir, workspace);
    expect((await call(server.base, 'GET', '/api/session', { cookie: b.cookie })).status).toBe(200);
    expect((await call(server.base, 'GET', '/api/session', { cookie: a.cookie })).status).toBe(401);
    const restored = await call(server.base, 'GET', `/api/tasks/${taskId}`, { cookie: b.cookie });
    expect(restored.status).toBe(200);
    expect(restored.body.task.turnState).toBe('interrupted');
    expect(restored.body.messages.map((message: MessageRecord) => message.content)).toContain('hello from client a');
  });
});
