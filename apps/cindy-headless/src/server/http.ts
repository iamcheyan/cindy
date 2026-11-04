import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ServerConfig } from './config.js';
import { randomToken, sha256 } from './config.js';
import type { InteractionDecisionInput, ServerRuntime } from './runtime.js';
import { CINDY_HEADLESS_VERSION } from '../compatibility.js';
import { HeadlessStore, type TaskRecord } from './store.js';
import { StaticWebFiles } from './static.js';
import { TailnetExposure, isTailnetHost, type PublicExposure } from './tailnet.js';

const BODY_LIMIT = 1024 * 1024;
const COOKIE_NAME = 'cindy_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const PAIRING_MS = 10 * 60 * 1000;
const MAX_SSE_PER_CLIENT = 4;

type ClientIdentity = { id: string; label: string };
type HttpOptions = { runtime: ServerRuntime; config: ServerConfig; store: HeadlessStore };
export interface WebServerHandle { server: Server; exposure: TailnetExposure; close(): Promise<void> }
type RequestContext = { request: IncomingMessage; response: ServerResponse; url: URL; body?: unknown; client?: ClientIdentity; csrf?: string };

function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  response.end(JSON.stringify(value));
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

function socketEncrypted(request: IncomingMessage): boolean {
  return 'encrypted' in request.socket && Boolean(request.socket.encrypted);
}

function requestIsSecure(request: IncomingMessage, tailnetHostname: string | undefined): boolean {
  return socketEncrypted(request) || isTailnetHost(request.headers.host, tailnetHostname);
}

function cookieValue(request: IncomingMessage): string | null {
  const raw = request.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index >= 0 && part.slice(0, index).trim() === COOKIE_NAME) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

function loopbackHost(host: string, port: number): boolean {
  const accepted = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `127.0.0.1`, `localhost`]);
  return accepted.has(host.toLowerCase());
}

function requestHostKind(request: IncomingMessage, port: number, tailnetHostname: string | undefined): 'loopback' | 'tailnet' | null {
  const host = request.headers.host;
  if (typeof host !== 'string') return null;
  if (loopbackHost(host, port)) return 'loopback';
  if (isTailnetHost(host, tailnetHostname)) return 'tailnet';
  return null;
}

function originAllowed(request: IncomingMessage, port: number, tailnetHostname: string | undefined): boolean {
  const origin = request.headers.origin;
  if (!origin) return request.method === 'GET' || request.method === 'HEAD';
  const kind = requestHostKind(request, port, tailnetHostname);
  if (!kind) return false;
  try {
    const parsed = new URL(origin);
    const requestHost = request.headers.host?.toLowerCase();
    if (!requestHost) return false;
    if (kind === 'tailnet') {
      return parsed.protocol === 'https:'
        && parsed.hostname.toLowerCase() === tailnetHostname
        && (parsed.port === '' || parsed.port === '443')
        && isTailnetHost(requestHost, tailnetHostname);
    }
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.host.toLowerCase() === requestHost
      && loopbackHost(parsed.host, port);
  } catch { return false; }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > BODY_LIMIT) throw new Error('BODY_TOO_LARGE');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > BODY_LIMIT) throw new Error('BODY_TOO_LARGE');
    chunks.push(bytes);
  }
  if (size === 0) return {};
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error('INVALID_CONTENT_TYPE');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new Error('INVALID_JSON'); }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_BODY');
  return value as Record<string, unknown>;
}

function assertKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new Error('INVALID_BODY_FIELDS');
}

function textField(body: Record<string, unknown>, key: string, max: number, required = false): string | undefined {
  const value = body[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length > max || value.trim() === '') throw new Error(`INVALID_${key.toUpperCase()}`);
  return value;
}

function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) throw new Error('INVALID_INTERACTION_DECISION');
  return value;
}

function interactionDecisionBody(value: unknown): InteractionDecisionInput {
  const body = objectBody(value);
  assertKeys(body, ['decision']);
  const decision = objectBody(body.decision);
  const kind = textField(decision, 'kind', 40, true)!;
  if (kind === 'permission') {
    assertKeys(decision, ['kind', 'behavior', 'scope', 'reason']);
    const behavior = textField(decision, 'behavior', 10, true)!;
    if (behavior !== 'allow' && behavior !== 'deny') throw new Error('INVALID_INTERACTION_DECISION');
    const scope = decision.scope === undefined ? undefined : textField(decision, 'scope', 20, true)!;
    if (scope !== undefined && scope !== 'once' && scope !== 'session') throw new Error('INVALID_INTERACTION_DECISION');
    const reason = optionalString(decision.reason, 2_000);
    return {
      kind: 'permission',
      behavior: behavior as 'allow' | 'deny',
      ...(scope ? { scope: scope as 'once' | 'session' } : {}),
      ...(reason ? { reason } : {}),
    };
  }
  if (kind === 'ask_user_question') {
    assertKeys(decision, ['kind', 'answers']);
    const answers = objectBody(decision.answers);
    const entries = Object.entries(answers);
    if (entries.length > 64) throw new Error('INVALID_INTERACTION_DECISION');
    const normalized: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, answer] of entries) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('INVALID_INTERACTION_DECISION');
      if (typeof answer !== 'string' || key.length === 0 || key.length > 4_000 || answer.length > 16_000) throw new Error('INVALID_INTERACTION_DECISION');
      normalized[key] = answer;
    }
    return { kind: 'ask_user_question', answers: normalized };
  }
  if (kind === 'plan_review') {
    assertKeys(decision, ['kind', 'behavior', 'editedPlan', 'reason']);
    const behavior = textField(decision, 'behavior', 10, true)!;
    if (behavior !== 'allow' && behavior !== 'deny') throw new Error('INVALID_INTERACTION_DECISION');
    const editedPlan = typeof decision.editedPlan === 'string' && decision.editedPlan.length <= 128 * 1024
      ? decision.editedPlan
      : undefined;
    if (decision.editedPlan !== undefined && editedPlan === undefined) throw new Error('INVALID_INTERACTION_DECISION');
    const reason = optionalString(decision.reason, 2_000);
    return {
      kind: 'plan_review',
      behavior: behavior as 'allow' | 'deny',
      ...(editedPlan !== undefined ? { editedPlan } : {}),
      ...(reason ? { reason } : {}),
    };
  }
  throw new Error('INVALID_INTERACTION_DECISION');
}

function intQuery(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new Error('INVALID_QUERY');
  return Math.min(Number(value), max);
}

function csrfFor(cookie: string, secret: string): string {
  return createHmac('sha256', secret).update(cookie).digest('base64url');
}

function setCookie(response: ServerResponse, token: string, secure: boolean, cookiePath: string): void {
  response.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure ? '; Secure' : ''}`);
}

function clearCookie(response: ServerResponse, secure: boolean, cookiePath: string): void {
  response.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
}

function statusForError(error: unknown): { status: number; code: string; message: string } {
  const message = error instanceof Error ? error.message : 'REQUEST_FAILED';
  if (message === 'BODY_TOO_LARGE') return { status: 413, code: message, message: 'Request body exceeds the server limit.' };
  if (message === 'INVALID_CONTENT_TYPE' || message === 'INVALID_JSON' || message.startsWith('INVALID_')) return { status: 400, code: message, message: 'Request is invalid.' };
  if (message === 'TASK_NOT_FOUND') return { status: 404, code: message, message: 'Task not found.' };
  if (message === 'WORKSPACE_OUTSIDE_ALLOWED_ROOT' || message === 'WORKSPACE_SYMLINK_NOT_ALLOWED') return { status: 403, code: message, message: 'Workspace is outside the configured server root.' };
  if (message === 'WORKSPACE_NOT_FOUND' || message === 'WORKSPACE_NOT_DIRECTORY') return { status: 400, code: message, message: 'Workspace must be an existing directory.' };
  if (message === 'UNSUPPORTED_TASK_OPTIONS') return { status: 400, code: message, message: 'Task options are not available on this server.' };
  if (message === 'SEND_NOT_ACCEPTED' || message.startsWith('SEND_NOT_ACCEPTED')) return { status: 409, code: 'SEND_NOT_ACCEPTED', message: 'The runtime did not accept this message.' };
  if (message === 'OUTCOME_UNKNOWN') return { status: 409, code: message, message: 'The previous request may have reached the agent. Review task history before sending again.' };
  if (message === 'IDEMPOTENCY_KEY_REUSED') return { status: 409, code: message, message: 'This request key was already used for different input.' };
  if (message === 'TASK_BUSY') return { status: 409, code: message, message: 'The task cannot be archived while its turn is running.' };
  if (message === 'TASK_ARCHIVED') return { status: 409, code: message, message: 'Restore the archived task before sending or stopping it.' };
  if (message === 'TASK_QUEUE_FULL') return { status: 429, code: message, message: 'Too many operations are waiting for this task.' };
  if (message === 'RUNTIME_UNAVAILABLE') return { status: 503, code: message, message: 'The server runtime is unavailable.' };
  return { status: 503, code: 'RUNTIME_ERROR', message: 'The server could not complete this operation.' };
}

function startSse(ctx: RequestContext, runtime: ServerRuntime, store: HeadlessStore, client: ClientIdentity, sessionHash: string, taskId: string, after: number, clientStreams: Map<string, Set<ServerResponse>>): void {
  if (!runtime.getTask(taskId)) { sendError(ctx.response, 404, 'TASK_NOT_FOUND', 'Task not found.'); return; }
  const streams = clientStreams.get(client.id) ?? new Set<ServerResponse>();
  if (streams.size >= MAX_SSE_PER_CLIENT) { sendError(ctx.response, 429, 'STREAM_LIMIT', 'Too many live event streams.'); return; }
  streams.add(ctx.response);
  clientStreams.set(client.id, streams);
  ctx.response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  let cursor = after;
  const currentCursor = store.eventCursor(taskId);
  const needsReset = cursor > currentCursor;
  if (needsReset) cursor = currentCursor;
  let closed = false;
  const writeRecord = (record: { seq: number; taskId: string; type: string; data: unknown; createdAt: number }) => {
    if (closed || record.seq <= cursor) return;
    cursor = record.seq;
    let eventName = 'agent';
    let eventType = record.type;
    let data: unknown = record.data;
    if (record.type === 'message:created') { eventName = 'message'; eventType = 'message'; }
    else if (record.type.startsWith('task:')) { eventName = 'task'; eventType = 'task'; data = runtime.getTask(taskId); }
    else if (record.type === 'agent:status') {
      const statusData = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {};
      eventType = 'status';
      data = { ...statusData, isRunning: runtime.getTurnState(taskId) === 'running' };
    }
    else if (record.type === 'interaction:request') {
      eventName = 'interaction';
      eventType = 'interaction';
      data = record.data && typeof record.data === 'object' && 'interaction' in record.data
        ? { interaction: (record.data as Record<string, unknown>).interaction }
        : { interaction: record.data };
    }
    else if (record.type === 'interaction:dismissed') {
      eventName = 'interaction-dismissed';
      eventType = 'interaction-dismissed';
      data = record.data && typeof record.data === 'object' ? record.data : { requestId: null };
    }
    else if (record.type === 'agent:event') {
      const projected = record.data && typeof record.data === 'object'
        ? record.data as Record<string, unknown>
        : null;
      eventType = projected && typeof projected.type === 'string' ? projected.type : 'agent';
      data = projected?.data ?? projected;
    }
    const payload = eventName === 'interaction'
      ? data
      : eventName === 'interaction-dismissed'
        ? data
        : { seq: record.seq, taskId, type: eventType, data, createdAt: record.createdAt };
    ctx.response.write(`id: ${record.seq}\nevent: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  const replay = () => {
    let page = runtime.listEvents(taskId, cursor, 500);
    while (page.length > 0) {
      for (const record of page) writeRecord(record);
      if (page.length < 500) break;
      page = runtime.listEvents(taskId, cursor, 500);
    }
  };
  ctx.response.write(`event: ready\nid: ${cursor}\ndata: ${JSON.stringify({ cursor })}\n\n`);
  if (needsReset) ctx.response.write(`event: reset\nid: ${cursor}\ndata: ${JSON.stringify({ cursor })}\n\n`);
  replay();
  const unsubscribe = runtime.onEvent(({ taskId: eventTaskId }) => { if (eventTaskId === taskId) replay(); });
  let beats = 0;
  const heartbeat = setInterval(() => {
    const grant = store.getSessionGrant(sessionHash);
    const owner = store.getClient(client.id);
    if (!grant || grant.revokedAt !== null || grant.expiresAt <= Date.now() || !owner || owner.revokedAt !== null) {
      cleanup();
      ctx.response.end();
      return;
    }
    beats += 1;
    if (!closed && beats % 10 === 0) ctx.response.write(': keep-alive\n\n');
  }, 2_000);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    streams.delete(ctx.response);
    if (streams.size === 0) clientStreams.delete(client.id);
  };
  ctx.response.once('close', cleanup);
}

export async function createWebServer(options: HttpOptions): Promise<WebServerHandle> {
  const { runtime, config, store } = options;
  let csrfSecret = store.getMeta('web_csrf_secret');
  if (!csrfSecret) {
    csrfSecret = randomToken();
    store.setMeta('web_csrf_secret', csrfSecret);
  }
  let listenPort = config.port;
  const tailnetHostname = config.tailscale?.hostname;
  const tailnetCookiePath = config.tailscale ? `${config.tailscale.path}/` : '/';
  const staticFiles = new StaticWebFiles(config.webRoot);
  await staticFiles.init();
  const exposure = new TailnetExposure(config, () => listenPort);
  const cookiePathFor = (request: IncomingMessage) => requestHostKind(request, listenPort, tailnetHostname) === 'tailnet'
    ? tailnetCookiePath
    : '/';
  const clientStreams = new Map<string, Set<ServerResponse>>();
  const rateWindows = new Map<string, { startedAt: number; count: number }>();
  const takeRate = (key: string, max: number): boolean => {
    const now = Date.now();
    for (const [entry, window] of rateWindows) if (now - window.startedAt >= 60_000) rateWindows.delete(entry);
    let window = rateWindows.get(key);
    if (!window) {
      if (rateWindows.size >= 4_096) return false;
      window = { startedAt: now, count: 0 };
      rateWindows.set(key, window);
    }
    if (now - window.startedAt >= 60_000) { window.startedAt = now; window.count = 0; }
    window.count += 1;
    return window.count <= max;
  };
  const respondPairingStatus = (
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    client: ClientIdentity | undefined,
    csrf: string | undefined,
    session: { expiresAt: number } | null,
  ): void => {
    const pending = store.getPendingClient(sha256(requestId));
    if (!pending || pending.expiresAt <= Date.now()) { sendJson(response, 200, { status: 'expired' }); return; }
    if (!pending.approvedAt) { sendJson(response, 200, { status: 'pending' }); return; }
    if (client && client.id === pending.clientId && session) {
      sendJson(response, 200, { status: 'approved', client, csrfToken: csrf, sessionExpiresAt: session.expiresAt });
      return;
    }
    const token = randomToken(32);
    const expiresAt = Date.now() + SESSION_MS;
    if (pending.redeemedAt || !pending.clientId || !store.redeemPendingClient(pending.id, sha256(token), expiresAt)) {
      sendJson(response, 200, { status: 'revoked' });
      return;
    }
    setCookie(response, token, requestIsSecure(request, tailnetHostname), cookiePathFor(request));
    sendJson(response, 200, {
      status: 'approved',
      client: { id: pending.clientId, label: pending.label },
      csrfToken: csrfFor(token, csrfSecret),
      sessionExpiresAt: expiresAt,
    });
  };
  const server = createServer(async (request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`); }
    catch { sendError(response, 400, 'INVALID_URL', 'Request URL is invalid.'); return; }
    const ctx: RequestContext = { request, response, url };
    try {
      const fetchSite = request.headers['sec-fetch-site'];
      if ((fetchSite && fetchSite !== 'same-origin' && !(fetchSite === 'none' && (request.method === 'GET' || request.method === 'HEAD')))
        || !requestHostKind(request, listenPort, tailnetHostname) || !originAllowed(request, listenPort, tailnetHostname)) {
        sendError(response, 403, 'ORIGIN_REJECTED', 'Host or Origin is not allowed.'); return;
      }
      const cookie = cookieValue(request);
      let session: { clientId: string; expiresAt: number; revokedAt: number | null } | null = null;
      if (cookie) session = store.getSessionGrant(sha256(cookie));
      if (session && session.expiresAt > Date.now() && session.revokedAt === null) {
        const clientRecord = store.getClient(session.clientId);
        if (clientRecord && clientRecord.revokedAt === null) {
          ctx.client = { id: clientRecord.id, label: clientRecord.label };
          ctx.csrf = csrfFor(cookie!, csrfSecret);
          store.touchClient(clientRecord.id);
        } else session = null;
      } else session = null;
      const rateKey = ctx.client ? `client:${ctx.client.id}` : `peer:${request.socket.remoteAddress ?? 'unknown'}`;
      const rateLimit = request.method === 'GET' || request.method === 'HEAD' ? 600 : ctx.client ? 120 : 300;
      if (!takeRate(rateKey, rateLimit)) { sendError(response, 429, 'RATE_LIMITED', 'Request rate limit reached.'); return; }
      if (request.method === 'POST' && url.pathname === '/api/auth/requests/status') {
        const peer = request.socket.remoteAddress ?? 'unknown';
        if (!takeRate(`pair-status:${peer}`, 120)) { sendError(response, 429, 'RATE_LIMITED', 'Pairing status rate limit reached.'); return; }
      }
      if (request.method === 'POST' || request.method === 'PATCH' || request.method === 'DELETE') {
        ctx.body = await readBody(request);
        if (ctx.url.pathname !== '/api/auth/requests' && ctx.url.pathname !== '/api/auth/requests/status' && (!ctx.client || request.headers['x-cindy-csrf'] !== ctx.csrf)) {
          sendError(response, ctx.client ? 403 : 401, ctx.client ? 'CSRF_FAILED' : 'UNAUTHENTICATED', ctx.client ? 'CSRF token is missing or invalid.' : 'Authentication required.'); return;
        }
      }
      const route = `${request.method ?? 'GET'} ${url.pathname}`;
      if (route === 'POST /api/auth/requests') {
        const peer = request.socket.remoteAddress ?? 'unknown';
        if (!takeRate(`pair:${peer}`, 10)) { sendError(response, 429, 'RATE_LIMITED', 'Pairing request rate limit reached.'); return; }
        const body = objectBody(ctx.body);
        assertKeys(body, ['label']);
        const label = textField(body, 'label', 80, true)!.trim();
        const now = Date.now();
        const requestId = randomToken(32);
        const pendingId = sha256(requestId);
        store.createPendingClient({ id: pendingId, label, codeHash: pendingId, createdAt: now, expiresAt: now + PAIRING_MS, approvedAt: null });
        sendJson(response, 201, { requestId, expiresAt: now + PAIRING_MS }); return;
      }
      if (route === 'POST /api/auth/requests/status') {
        const body = objectBody(ctx.body);
        assertKeys(body, ['requestId']);
        const requestId = textField(body, 'requestId', 80, true)!;
        if (!/^[A-Za-z0-9_-]{32,80}$/.test(requestId)) throw new Error('INVALID_REQUEST_ID');
        respondPairingStatus(request, response, requestId, ctx.client, ctx.csrf, session);
        return;
      }
      if (route === 'GET /api/session') {
        if (!ctx.client || !session) { sendError(response, 401, 'UNAUTHENTICATED', 'Authentication required.'); return; }
        const profile = runtime.resolvedProfile.profile;
        const currentExposure: PublicExposure = await exposure.get();
        sendJson(response, 200, {
          client: ctx.client,
          csrfToken: ctx.csrf,
          sessionExpiresAt: session.expiresAt,
          server: {
            contractVersion: 1,
            version: CINDY_HEADLESS_VERSION, startedAt: runtime.startedAt,
            exposure: currentExposure,
            capabilities: {
              agents: [{ id: profile.agentBackend, label: profile.agentBackend, models: [profile.model.requestedId], efforts: profile.model.effort ? [profile.model.effort] : [], permissionModes: [profile.permissionMode] }],
              defaultWorkspace: runtime.defaultWorkspace,
            },
          },
        }); return;
      }
      if (route === 'POST /api/auth/logout') {
        if (!ctx.client || !cookie) { sendError(response, 401, 'UNAUTHENTICATED', 'Authentication required.'); return; }
        store.revokeSession(sha256(cookie));
        clearCookie(response, requestIsSecure(request, tailnetHostname), cookiePathFor(request));
        response.writeHead(204, { 'Cache-Control': 'no-store' }); response.end(); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/tasks') {
        if (!ctx.client) { sendError(response, 401, 'UNAUTHENTICATED', 'Authentication required.'); return; }
        const status = url.searchParams.get('status') ?? 'active';
        if (!['active', 'archived', 'all'].includes(status)) throw new Error('INVALID_STATUS');
        const limit = Math.max(1, intQuery(url.searchParams.get('limit'), 100, 100));
        const cursor = url.searchParams.get('cursor');
        let tasks = runtime.listTasks().filter((task) => status === 'all' || task.status === status);
        if (cursor) {
          const split = cursor.indexOf(':');
          const cursorTime = Number(cursor.slice(0, split));
          const cursorId = cursor.slice(split + 1);
          if (split < 1 || !Number.isSafeInteger(cursorTime) || !cursorId) throw new Error('INVALID_CURSOR');
          tasks = tasks.filter((task) => task.updatedAt < cursorTime || (task.updatedAt === cursorTime && task.id < cursorId));
        }
        const page = tasks.slice(0, limit);
        const last = page[page.length - 1];
        sendJson(response, 200, { tasks: page, nextCursor: tasks.length > page.length && last ? `${last.updatedAt}:${last.id}` : null }); return;
      }
      const eventsMatch = url.pathname.match(/^\/api\/tasks\/([A-Za-z0-9_-]+)\/events$/);
      if (request.method === 'GET' && eventsMatch) {
        if (!ctx.client) { sendError(response, 401, 'UNAUTHENTICATED', 'Authentication required.'); return; }
        const lastEventIdHeader = request.headers['last-event-id'];
        const lastId = typeof lastEventIdHeader === 'string' && lastEventIdHeader ? lastEventIdHeader : null;
        // EventSource reuses the original URL on reconnect; Last-Event-ID must win over its query.
        const after = intQuery(lastId ?? url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER);
        if (!cookie) { sendError(response, 401, 'UNAUTHENTICATED', 'Authentication required.'); return; }
        startSse(ctx, runtime, store, ctx.client, sha256(cookie), eventsMatch[1]!, after, clientStreams); return;
      }
      const interactionsMatch = url.pathname.match(/^\/api\/tasks\/([A-Za-z0-9_-]+)\/interactions$/);
      if (request.method === 'GET' && interactionsMatch) {
        if (!ctx.client) { sendError(response, 401, 'UNAUTHENTICATED', 'Authentication required.'); return; }
        if (!runtime.getTask(interactionsMatch[1]!)) { sendError(response, 404, 'TASK_NOT_FOUND', 'Task not found.'); return; }
        sendJson(response, 200, { interactions: runtime.listInteractions(interactionsMatch[1]!) }); return;
      }
      const interactionResolveMatch = url.pathname.match(/^\/api\/tasks\/([A-Za-z0-9_-]+)\/interactions\/([^/]+)$/);
      if (request.method === 'POST' && interactionResolveMatch) {
        if (!ctx.client) { sendError(response, 401, 'UNAUTHENTICATED', 'Authentication required.'); return; }
        let requestId: string;
        try { requestId = decodeURIComponent(interactionResolveMatch[2]!); } catch { throw new Error('INVALID_INTERACTION_ID'); }
        if (requestId.length === 0 || requestId.length > 200) throw new Error('INVALID_INTERACTION_ID');
        const decision = interactionDecisionBody(ctx.body);
        sendJson(response, 200, { accepted: runtime.resolveInteraction(interactionResolveMatch[1]!, requestId, decision) }); return;
      }
      const messagesMatch = url.pathname.match(/^\/api\/tasks\/([A-Za-z0-9_-]+)\/messages$/);
      if (request.method === 'GET' && messagesMatch) {
        if (!ctx.client) { sendError(response, 401, 'UNAUTHENTICATED', 'Authentication required.'); return; }
        const task = runtime.getTask(messagesMatch[1]!);
        if (!task) { sendError(response, 404, 'TASK_NOT_FOUND', 'Task not found.'); return; }
        const after = intQuery(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER);
        const limit = Math.max(1, intQuery(url.searchParams.get('limit'), 200, 500));
        const messages = runtime.listMessages(task.id, after, limit);
        sendJson(response, 200, { messages, cursor: messages.length ? messages[messages.length - 1]!.seq : after, eventCursor: runtime.getEventCursor(task.id) }); return;
      }
      const stopMatch = url.pathname.match(/^\/api\/tasks\/([A-Za-z0-9_-]+)\/stop$/);
      if (request.method === 'POST' && stopMatch) {
        if (!ctx.client) { sendError(response, 401, 'UNAUTHENTICATED', 'Authentication required.'); return; }
        await runtime.stopTask(stopMatch[1]!);
        sendJson(response, 200, { ok: true }); return;
      }
      if (route === 'POST /api/tasks') {
        if (!ctx.client) { sendError(response, 401, 'UNAUTHENTICATED', 'Authentication required.'); return; }
        const body = objectBody(ctx.body);
        assertKeys(body, ['title', 'workspace', 'agentKind', 'model', 'provider', 'effort', 'permissionMode']);
        const created = await runtime.createTask({
          title: textField(body, 'title', 200), workspace: textField(body, 'workspace', 4096),
          agentKind: textField(body, 'agentKind', 80), model: textField(body, 'model', 200),
          provider: textField(body, 'provider', 200), effort: textField(body, 'effort', 40), permissionMode: textField(body, 'permissionMode', 40),
        }, ctx.client.id);
        sendJson(response, 201, { task: created.task }); return;
      }
      const messageMatch = url.pathname.match(/^\/api\/tasks\/([A-Za-z0-9_-]+)\/messages$/);
      if (request.method === 'POST' && messageMatch) {
        if (!ctx.client) { sendError(response, 401, 'UNAUTHENTICATED', 'Authentication required.'); return; }
        const body = objectBody(ctx.body);
        assertKeys(body, ['content', 'clientId']);
        const content = textField(body, 'content', 64 * 1024, true)!;
        const key = request.headers['idempotency-key'];
        const message = await runtime.sendMessage(messageMatch[1]!, content, ctx.client.id, typeof key === 'string' ? key : undefined);
        sendJson(response, 201, { message }); return;
      }
      const taskMatch = url.pathname.match(/^\/api\/tasks\/([A-Za-z0-9_-]+)$/);
      if (request.method === 'GET' && taskMatch) {
        if (!ctx.client) { sendError(response, 401, 'UNAUTHENTICATED', 'Authentication required.'); return; }
        const task = runtime.getTask(taskMatch[1]!);
        if (!task) { sendError(response, 404, 'TASK_NOT_FOUND', 'Task not found.'); return; }
        const after = intQuery(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER);
        const limit = Math.max(1, intQuery(url.searchParams.get('limit'), 200, 500));
        const messages = runtime.listMessages(task.id, after, limit);
        const text = runtime.getStreamingText(task.id);
        const turnState = runtime.getTurnState(task.id);
        const messageCursor = messages.length ? messages[messages.length - 1]!.seq : after;
        const eventCursor = runtime.getEventCursor(task.id);
        sendJson(response, 200, {
          task: { ...task, turnState },
          messages,
          // Web 客户端把 snapshot.cursor 直接作为 SSE 起始游标；消息分页游标另见 messageCursor。
          cursor: eventCursor,
          eventCursor,
          messageCursor,
          running: turnState === 'running',
          streaming: text ? { text, kind: 'text' } : null,
          interactions: runtime.listInteractions(task.id),
        }); return;
      }
      if (request.method === 'PATCH' && taskMatch) {
        if (!ctx.client) { sendError(response, 401, 'UNAUTHENTICATED', 'Authentication required.'); return; }
        const body = objectBody(ctx.body);
        const keys = Object.keys(body);
        if (keys.length !== 1 || !['title', 'status'].includes(keys[0]!)) throw new Error('INVALID_TASK_PATCH');
        let updated: TaskRecord | null;
        if (keys[0] === 'title') {
          const title = textField(body, 'title', 200, true)!.trim();
          if (!title) throw new Error('INVALID_TITLE');
          updated = await runtime.updateTask(taskMatch[1]!, { title });
        } else {
          const status = body.status;
          if (status !== 'active' && status !== 'archived') throw new Error('INVALID_STATUS');
          updated = await runtime.updateTask(taskMatch[1]!, { status });
        }
        if (!updated) { sendError(response, 404, 'TASK_NOT_FOUND', 'Task not found.'); return; }
        sendJson(response, 200, { task: updated }); return;
      }
      if (url.pathname.startsWith('/api/')) { sendError(response, 404, 'NOT_FOUND', 'API route not found.'); return; }
      if (await staticFiles.handle(request, response, url.pathname)) return;
      sendError(response, 404, 'NOT_FOUND', 'Resource not found.');
    } catch (error) {
      const mapped = statusForError(error);
      if (!response.headersSent) sendError(response, mapped.status, mapped.code, mapped.message);
      else response.destroy();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(config.port, '127.0.0.1', () => {
    server.removeListener('error', listening.reject);
    const address = server.address();
    if (address && typeof address === 'object') listenPort = address.port;
    listening.resolve();
  });
  await listening.promise;
  return {
    server,
    exposure,
    async close() {
      for (const streams of clientStreams.values()) for (const response of streams) response.end();
      const closing = Promise.withResolvers<void>();
      const force = setTimeout(() => server.closeAllConnections(), 5_000);
      server.close(() => { clearTimeout(force); closing.resolve(); });
      server.closeIdleConnections();
      await closing.promise;
    },
  };
}
