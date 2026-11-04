import { access, chmod, mkdir, realpath, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type AgentEvent,
  type Maker,
  type Session,
  type CreateSessionOptions,
  type InteractionDecision,
  type InteractionRequest,
  type Logger,
} from '@cindy/maker-core';
import { createHeadlessMaker } from '../host.js';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { readProfile, validateProfile, type HeadlessProfile, type ResolvedProfile } from '../profile.js';
import { assertSafeExecutionProfile } from '../compatibility.js';
import type { ServerConfig } from './config.js';
import { HeadlessStore, type MessageRecord, type TaskRecord } from './store.js';

export interface RuntimeTask {
  task: TaskRecord;
  session: Session;
  unsubscribers: Array<() => void>;
}

export interface CreateTaskInput {
  title?: string;
  agentKind?: string;
  model?: string;
  provider?: string;
  effort?: string;
  permissionMode?: string;
  workspace?: string;
}

export interface PendingInteractionView {
  request: InteractionRequest;
  createdAt: number;
}

export type InteractionDecisionInput =
  | { kind: 'permission'; behavior: 'allow' | 'deny'; scope?: 'once' | 'session'; reason?: string }
  | { kind: 'ask_user_question'; answers: Record<string, string> }
  | { kind: 'plan_review'; behavior: 'allow' | 'deny'; editedPlan?: string; reason?: string };

interface PendingInteraction {
  taskId: string;
  request: InteractionRequest;
  createdAt: number;
  resolve(decision: InteractionDecision): void;
}

const TASK_TITLE_MAX = 200;
const MAX_MESSAGE_LENGTH = 64 * 1024;
const SERVER_SECRET_VALUES = [...new Set(Object.entries(process.env)
  .filter(([name, value]) => value && /api.?key|token|secret|password|credential|authorization/i.test(name))
  .map(([, value]) => value!)
  .filter((value) => value.length >= 4))];
const execFileAsync = promisify(nodeExecFile);

function redactServerSecrets(value: string): string {
  let output = redactSensitiveText(value);
  for (const secret of SERVER_SECRET_VALUES) output = output.replaceAll(secret, '[REDACTED]');
  return output;
}

function titleFromPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  return normalized.slice(0, TASK_TITLE_MAX) || 'New task';
}

export async function resolveServerProfile(config: ServerConfig, dataDir: string): Promise<ResolvedProfile> {
  const profilePath = path.join(dataDir, 'server-profile.json');
  const defaults = config.taskDefaults;
  const profile: HeadlessProfile = {
    id: 'cindy-server',
    version: 1,
    agentBackend: defaults.agentBackend,
    agentBinaryPath: defaults.agentBinaryPath,
    agentBinaryVersion: 'server',
    supportedModelIds: [defaults.model],
    model: {
      provider: defaults.provider,
      requestedId: defaults.model,
      ...(defaults.effort ? { effort: defaults.effort } : {}),
    },
    permissionMode: defaults.permissionMode,
    ...(config.systemPromptFile ? { systemPromptFile: config.systemPromptFile } : {}),
    ...(config.systemPromptDigest ? { expectedSystemPromptDigest: config.systemPromptDigest } : {}),
    makerMemory: false,
    nativeMemory: false,
    projectContext: false,
  };
  await writeFile(profilePath, JSON.stringify(profile, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await chmod(profilePath, 0o600);
  const resolved = await readProfile(profilePath);
  const version = resolved.profile.agentBinaryVersion === 'server'
    ? await execFileAsync(resolved.profile.agentBinaryPath, ['--version'], { timeout: 30_000 })
    : null;
  const effective = validateProfile({
    ...resolved.profile,
    agentBinaryVersion: version ? `${version.stdout} ${version.stderr}`.trim() : resolved.profile.agentBinaryVersion,
  });
  assertSafeExecutionProfile(effective);
  return { ...resolved, profile: effective };
}

function sessionStartOptions(task: TaskRecord): CreateSessionOptions {
  return {
    id: task.id,
    agentKind: task.agentKind as CreateSessionOptions['agentKind'],
    workingDir: task.workspace,
    title: task.title,
    model: task.model,
    providerId: task.provider,
    ...(task.effort ? { effort: task.effort as CreateSessionOptions['effort'] } : {}),
    permissionMode: task.permissionMode as CreateSessionOptions['permissionMode'],
  };
}

function boundedEventValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    const safe = redactServerSecrets(value);
    return safe.length > 4_000 ? `${safe.slice(0, 4_000)}…` : safe;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => boundedEventValue(item, depth + 1));
  if (typeof value !== 'object') return undefined;
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (/secret|password|authorization|api.?key|access.?token|refresh.?token|credential/i.test(key)) continue;
    output[key] = boundedEventValue(item, depth + 1);
  }
  return output;
}

function projectEvent(event: AgentEvent): AgentEvent {
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { type: event.type, data: boundedEventValue(data ?? null) };
  const value = data as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of ['text', 'isFinal', 'thinking', 'status', 'message', 'toolUseId', 'toolName', 'input', 'result', 'usage', 'costUsd', 'tokenUsage', 'contextTokens', 'contextWindow', 'errorCode', 'interactionId', 'interactionType']) {
    if (key in value) safe[key] = boundedEventValue(value[key]);
  }
  return { type: event.type, data: safe };
}

function sanitizeLogValue(value: unknown, key = '', depth = 0): unknown {
  if (/secret|password|authorization|api.?key|access.?token|refresh.?token|credential|cookie/i.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    return redactServerSecrets(value)
      .replace(/(?:\/[-A-Za-z0-9._]+){2,}|[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/g, '[redacted]')
      .slice(0, 1_000);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeLogValue(item, key, depth + 1));
  if (typeof value !== 'object') return '[redacted]';
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [childKey, childValue] of Object.entries(value).slice(0, 40)) {
    if (childKey === '__proto__' || childKey === 'constructor' || childKey === 'prototype') continue;
    output[childKey] = sanitizeLogValue(childValue, childKey, depth + 1);
  }
  return output;
}

function serverLogger(): Logger {
  const write = (level: string, message: string, context?: Record<string, unknown>) => {
    process.stderr.write(`${JSON.stringify({ level, message: String(sanitizeLogValue(message)), ...(context ? sanitizeLogValue(context) as Record<string, unknown> : {}) })}\n`);
  };
  const logger: Logger = {
    trace: (message, context) => write('trace', message, context),
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
    fatal: (message, context) => write('fatal', message, context),
    child: () => logger,
  };
  return logger;
}

function dismissedDecision(request: InteractionRequest, reason: string): InteractionDecision {
  if (request.kind === 'ask_user_question') return { kind: 'ask_user_question', answers: {}, dismissed: true };
  if (request.kind === 'plan_review') return { kind: 'plan_review', behavior: 'deny', reason, dismissed: true };
  return { kind: 'permission', behavior: 'deny', reason };
}

function projectInteraction(request: InteractionRequest): InteractionRequest {
  if (request.kind === 'permission') {
    const boundedInput = boundedEventValue(request.input);
    const input = boundedInput && typeof boundedInput === 'object' && !Array.isArray(boundedInput)
      ? boundedInput as Record<string, unknown>
      : {};
    return {
      kind: 'permission',
      requestId: request.requestId,
      toolName: request.toolName.slice(0, 200),
      input,
      ...(request.title ? { title: request.title.slice(0, 500) } : {}),
      ...(request.displayName ? { displayName: request.displayName.slice(0, 200) } : {}),
      ...(request.description ? { description: request.description.slice(0, 4_000) } : {}),
      ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
    };
  }
  if (request.kind === 'ask_user_question') {
    return {
      kind: 'ask_user_question',
      requestId: request.requestId,
      questions: request.questions.slice(0, 20).map((question) => ({
        ...question,
        question: question.question.slice(0, 4_000),
        ...(question.header ? { header: question.header.slice(0, 200) } : {}),
        ...(question.options ? {
          options: question.options.slice(0, 20).map((option) => ({
            label: option.label.slice(0, 200),
            ...(option.description ? { description: option.description.slice(0, 1_000) } : {}),
          })),
        } : {}),
      })),
      ...(request.delivery ? { delivery: request.delivery } : {}),
      ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
    };
  }
  return {
    kind: 'plan_review',
    requestId: request.requestId,
    plan: request.plan.slice(0, 128 * 1024),
    ...(request.planFilePath ? { planFilePath: request.planFilePath.slice(0, 4_096) } : {}),
    ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
  };
}

function interactionDecision(request: InteractionRequest, input: InteractionDecisionInput): InteractionDecision {
  if (input.kind !== request.kind) throw new Error('INVALID_INTERACTION_DECISION');
  if (request.kind === 'permission') {
    if (input.kind !== 'permission') throw new Error('INVALID_INTERACTION_DECISION');
    if (input.behavior !== 'allow' && input.behavior !== 'deny') throw new Error('INVALID_INTERACTION_DECISION');
    if (input.scope !== undefined && input.scope !== 'once' && input.scope !== 'session') throw new Error('INVALID_INTERACTION_DECISION');
    if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 2_000)) throw new Error('INVALID_INTERACTION_DECISION');
    const sessionWide = input.behavior === 'allow'
      && input.scope === 'session'
      && request.metadata?.hostOwnedConfirmation === undefined;
    return {
      kind: 'permission',
      behavior: input.behavior,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(sessionWide ? {
        permissionUpdates: [{ type: 'addRules', rules: [{ toolName: request.toolName }], behavior: 'allow', destination: 'session' }],
      } : {}),
    };
  }
  if (request.kind === 'ask_user_question') {
    if (input.kind !== 'ask_user_question') throw new Error('INVALID_INTERACTION_DECISION');
    if (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers)) throw new Error('INVALID_INTERACTION_DECISION');
    const answers: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, value] of Object.entries(input.answers)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('INVALID_INTERACTION_DECISION');
      if (typeof value !== 'string' || key.length === 0 || key.length > 4_000 || value.length > 16_000) throw new Error('INVALID_INTERACTION_DECISION');
      answers[key] = value;
    }
    return { kind: 'ask_user_question', answers };
  }
  if (input.kind !== 'plan_review') throw new Error('INVALID_INTERACTION_DECISION');
  if (input.behavior !== 'allow' && input.behavior !== 'deny') throw new Error('INVALID_INTERACTION_DECISION');
  if (input.editedPlan !== undefined && (typeof input.editedPlan !== 'string' || input.editedPlan.length > 128 * 1024)) throw new Error('INVALID_INTERACTION_DECISION');
  if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 2_000)) throw new Error('INVALID_INTERACTION_DECISION');
  const cancelling = input.behavior === 'deny' && !input.reason && input.editedPlan === undefined;
  return {
    kind: 'plan_review',
    behavior: input.behavior,
    ...(input.editedPlan !== undefined ? { editedPlan: input.editedPlan } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(cancelling ? { dismissed: true, reason: 'user_cancelled' } : {}),
  };
}

function eventMessage(event: AgentEvent): { role: MessageRecord['role']; kind: string; content: string } | null {
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
  if (event.type === 'text' && data.isFinal === true && typeof data.text === 'string' && data.text.length > 0) {
    return { role: 'assistant', kind: 'text', content: redactServerSecrets(data.text).slice(0, 256 * 1024) };
  }
  if (event.type === 'error') {
    const content = typeof data.message === 'string' ? redactServerSecrets(data.message).slice(0, 8_000) : 'Agent error';
    return { role: 'assistant', kind: 'error', content };
  }
  return null;
}

export class ServerRuntime {
  readonly store: HeadlessStore;
  readonly resolvedProfile: ResolvedProfile;
  readonly defaultWorkspace: string;
  private readonly configuredWorkspaceRoot: string;
  readonly startedAt = Date.now();
  private readonly maker: Maker;
  private readonly shutdownRuntime: () => Promise<void>;
  private readonly active = new Map<string, RuntimeTask>();
  private readonly taskQueues = new Map<string, Promise<unknown>>();
  private readonly taskQueueDepth = new Map<string, number>();
  private readonly listeners = new Set<(event: { taskId: string; event: AgentEvent; record?: unknown }) => void>();
  private readonly interrupted = new Set<string>();
  private readonly stopRequested = new Set<string>();
  private readonly turnAttemptTokens = new Map<string, number>();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly taskInteractions = new Map<string, Set<string>>();
  private readonly streamingText = new Map<string, string>();
  private closed = false;

  private constructor(store: HeadlessStore, resolvedProfile: ResolvedProfile, maker: Maker, workspaceRoot: string, shutdownRuntime: () => Promise<void>) {
    this.store = store;
    this.configuredWorkspaceRoot = workspaceRoot;
    this.defaultWorkspace = workspaceRoot;
    this.resolvedProfile = resolvedProfile;
    this.maker = maker;
    this.shutdownRuntime = shutdownRuntime;
    for (const taskId of store.markRunningTurnsInterrupted()) {
      this.interrupted.add(taskId);
      const notice = store.appendMessage({
        id: randomUUID(), taskId, role: 'system', kind: 'notice',
        content: 'The previous server process ended during this turn. Its agent process and outcome could not be restored; review the task history before continuing.',
        createdAt: Date.now(),
      });
      store.appendEvent(taskId, 'message:created', notice);
    }
    for (const pending of store.clearPendingInteractions()) {
      store.appendEvent(pending.taskId, 'interaction:dismissed', { requestId: pending.requestId, reason: 'server_restart' });
    }
  }

  static async start(config: ServerConfig, dataDir: string): Promise<ServerRuntime> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await chmod(dataDir, 0o700);
    await mkdir(config.workspaceRoot, { recursive: true, mode: 0o700 });
    const claudeConfigDir = path.join(dataDir, 'claude-config');
    await mkdir(claudeConfigDir, { recursive: true, mode: 0o700 });
    await chmod(claudeConfigDir, 0o700);
    if (!process.env.CLAUDE_CONFIG_DIR) process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    const workspaceRoot = await realpath(config.workspaceRoot);
    await access(config.taskDefaults.agentBinaryPath);
    const resolved = await resolveServerProfile(config, dataDir);
    const store = await HeadlessStore.open(dataDir);
    let host: { maker: Maker; shutdownBridge(): Promise<void>; sessionStorage: { close(): void } } | undefined;
    try {
      host = createHeadlessMaker(resolved, dataDir, workspaceRoot, null, [], serverLogger());
      return new ServerRuntime(store, resolved, host.maker, workspaceRoot, async () => {
        try { await host!.maker.shutdown(); } finally {
          await host!.shutdownBridge().catch(() => undefined);
          host!.sessionStorage.close();
        }
      });
    } catch (error) {
      try { await host?.maker.shutdown(); } catch { /* startup failure remains primary */ }
      await host?.shutdownBridge().catch(() => undefined);
      host?.sessionStorage.close();
      store.close();
      throw error;
    }
  }

  onEvent(listener: (event: { taskId: string; event: AgentEvent; record?: unknown }) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  listTasks(): TaskRecord[] { return this.store.listTasks(); }
  getTask(id: string): TaskRecord | null { return this.store.getTask(id); }
  listMessages(id: string, after = 0, limit = 200): MessageRecord[] { return this.store.listMessages(id, after, limit); }
  listEvents(id: string, after = 0, limit = 200) { return this.store.listEvents(id, after, limit); }
  getTurnState(id: string): string { return this.store.getTurn(id)?.state ?? 'idle'; }
  getEventCursor(id: string): number { return this.store.eventCursor(id); }

  getStreamingText(id: string): string | null { return this.streamingText.get(id) || null; }

  async createTask(input: CreateTaskInput, clientId: string): Promise<RuntimeTask> {
    if (this.closed) throw new Error('RUNTIME_UNAVAILABLE');
    const defaults = this.resolvedProfile.profile;
    if ((input.agentKind && input.agentKind !== defaults.agentBackend)
      || (input.model && input.model !== defaults.model.requestedId)
      || (input.provider && input.provider !== defaults.model.provider)
      || (input.effort && input.effort !== defaults.model.effort)
      || (input.permissionMode && input.permissionMode !== defaults.permissionMode)) {
      throw new Error('UNSUPPORTED_TASK_OPTIONS');
    }
    const workspaceRoot = await realpath(this.configuredWorkspaceRoot);
    const workspace = path.resolve(input.workspace ?? workspaceRoot);
    const relative = path.relative(workspaceRoot, workspace);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('WORKSPACE_OUTSIDE_ALLOWED_ROOT');
    const info = await lstat(workspace).catch(() => { throw new Error('WORKSPACE_NOT_FOUND'); });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('WORKSPACE_NOT_DIRECTORY');
    const actualWorkspace = await realpath(workspace);
    if (actualWorkspace !== workspace) throw new Error('WORKSPACE_SYMLINK_NOT_ALLOWED');
    const now = Date.now();
    const task: TaskRecord = {
      id: randomUUID(),
      title: input.title?.trim().slice(0, TASK_TITLE_MAX) || 'New task',
      agentKind: defaults.agentBackend,
      model: defaults.model.requestedId,
      provider: defaults.model.provider,
      ...(defaults.model.effort ? { effort: defaults.model.effort } : {}),
      permissionMode: defaults.permissionMode,
      workspace: actualWorkspace,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    let session: Session | undefined;
    let attached: RuntimeTask | undefined;
    try {
      session = await this.maker.createSession(sessionStartOptions(task));
      this.store.createTask(task);
      attached = this.attach(task, session);
      this.store.appendEvent(task.id, 'task:created', { task, clientId });
      return attached;
    } catch (error) {
      if (attached) {
        this.active.delete(task.id);
        for (const unsubscribe of attached.unsubscribers) unsubscribe();
      }
      await session?.close().catch(() => undefined);
      this.store.deleteTask(task.id);
      throw error;
    }
  }

  private attach(task: TaskRecord, session: Session): RuntimeTask {
    const taskId = task.id;
    session.setInteractionListener((request, signal) => this.awaitInteraction(taskId, request, signal));
    const unsubscribers = [
      () => session.setInteractionListener(null),
      session.onEvent((rawEvent) => {
        try {
        if (rawEvent.type === 'interaction_dismissed') {
          const data = rawEvent.data && typeof rawEvent.data === 'object' ? rawEvent.data as Record<string, unknown> : {};
          if (typeof data.requestId === 'string') {
            this.handleInteractionDismissed(taskId, data.requestId, typeof data.reason === 'string' ? data.reason : 'dismissed');
          }
        }
        const event = projectEvent(rawEvent);
        const data = rawEvent.data && typeof rawEvent.data === 'object' ? rawEvent.data as Record<string, unknown> : {};
        const eventToken = typeof rawEvent.turnAttemptToken === 'number' ? rawEvent.turnAttemptToken : undefined;
        const currentToken = this.turnAttemptTokens.get(taskId);
        const staleTurn = rawEvent.turnScope !== 'background' && eventToken !== undefined && currentToken !== undefined && eventToken !== currentToken;
        if (staleTurn) return;
        if (rawEvent.type === 'text' && typeof data.text === 'string') {
          const safeText = redactServerSecrets(data.text);
          const next = data.isFinal === true ? safeText : `${this.streamingText.get(taskId) ?? ''}${safeText}`;
          this.streamingText.set(taskId, next.length > MAX_MESSAGE_LENGTH ? next.slice(-MAX_MESSAGE_LENGTH) : next);
        }
        const eventRecord = this.store.appendEvent(taskId, 'agent:event', event);
        const message = eventMessage(rawEvent) ?? (rawEvent.type === 'done' && rawEvent.turnScope !== 'background' && this.streamingText.get(taskId)
          ? { role: 'assistant' as const, kind: 'text', content: this.streamingText.get(taskId)! }
          : null);
        if (message) {
          const stored = this.store.appendMessage({ id: randomUUID(), taskId, ...message, createdAt: Date.now() });
          this.store.appendEvent(taskId, 'message:created', stored);
          this.applyTaskUpdate(taskId, {});
          for (const listener of this.listeners) listener({ taskId, event, record: stored });
          if (rawEvent.type === 'text' && data.isFinal === true) this.streamingText.delete(taskId);
        }
        if ((rawEvent.type === 'done' || rawEvent.type === 'error') && rawEvent.turnScope !== 'background') {
          const belongsToCurrentTurn = eventToken === undefined || currentToken === undefined || eventToken === currentToken;
          if (belongsToCurrentTurn) {
            if (this.stopRequested.has(taskId)) {
              this.stopRequested.delete(taskId);
              this.store.setTurn(taskId, 'interrupted');
            } else {
              this.store.setTurn(taskId, rawEvent.type === 'done' ? 'completed' : 'failed');
            }
            this.streamingText.delete(taskId);
          }
        }
        for (const listener of this.listeners) listener({ taskId, event, record: eventRecord });
        } catch (error) {
          serverLogger().error('failed to persist agent event', { error: error instanceof Error ? error.message : String(error), taskId });
        }
      }),
      session.onStatusChange((status) => {
        try {
          if (status === 'closed' || status === 'error') this.dismissTaskInteractions(taskId, 'session_closed');
          const event: AgentEvent = { type: 'status', data: { status } };
          const record = this.store.appendEvent(taskId, 'agent:status', event.data);
          for (const listener of this.listeners) listener({ taskId, event, record });
        } catch (error) {
          serverLogger().error('failed to persist agent status', { error: error instanceof Error ? error.message : String(error), taskId });
        }
      }),
    ];
    const runtime = { task, session, unsubscribers };
    this.active.set(taskId, runtime);
    return runtime;
  }

  async openTask(id: string): Promise<RuntimeTask> {
    if (this.closed) throw new Error('RUNTIME_UNAVAILABLE');
    const existing = this.active.get(id);
    if (existing) return existing;
    const task = this.store.getTask(id);
    if (!task) throw new Error('TASK_NOT_FOUND');
    const stored = await this.maker.getSessionMeta(id);
    const session = await this.maker.createSession({
      ...sessionStartOptions(task),
      ...(stored?.sdkSessionId ? { resumeSessionId: stored.sdkSessionId } : {}),
    });
    const runtime = this.attach(task, session);
    if (this.interrupted.delete(id)) {
      this.store.appendEvent(id, 'task:interrupted', { state: 'interrupted' });
    }
    return runtime;
  }

  private async serializeTask<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const depth = this.taskQueueDepth.get(taskId) ?? 0;
    if (depth >= 32) throw new Error('TASK_QUEUE_FULL');
    this.taskQueueDepth.set(taskId, depth + 1);
    const previous = this.taskQueues.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.taskQueues.set(taskId, next);
    try { return await next; } finally {
      const currentDepth = (this.taskQueueDepth.get(taskId) ?? 1) - 1;
      if (currentDepth === 0) this.taskQueueDepth.delete(taskId);
      else this.taskQueueDepth.set(taskId, currentDepth);
      if (this.taskQueues.get(taskId) === next) this.taskQueues.delete(taskId);
    }
  }

  listInteractions(taskId: string): PendingInteractionView[] {
    const ids = this.taskInteractions.get(taskId);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.pendingInteractions.get(id))
      .filter((entry): entry is PendingInteraction => Boolean(entry))
      .map((entry) => ({ request: projectInteraction(entry.request), createdAt: entry.createdAt }));
  }

  resolveInteraction(taskId: string, requestId: string, input: InteractionDecisionInput): boolean {
    const pending = this.pendingInteractions.get(requestId);
    if (!pending || pending.taskId !== taskId) return false;
    pending.resolve(interactionDecision(pending.request, input));
    return true;
  }

  private interactionView(request: InteractionRequest): PendingInteractionView {
    return { request: projectInteraction(request), createdAt: Date.now() };
  }

  private emitInteraction(taskId: string, type: string, data: unknown): void {
    const record = this.store.appendEvent(taskId, type, data);
    for (const listener of this.listeners) listener({ taskId, event: { type: 'status', data: { interaction: type } }, record });
  }

  private awaitInteraction(taskId: string, request: InteractionRequest, signal?: AbortSignal): Promise<InteractionDecision> {
    const view = this.interactionView(request);
    return new Promise<InteractionDecision>((resolve) => {
      let settled = false;
      let onAbort: () => void = () => undefined;
      const settle = (decision: InteractionDecision, reason?: string) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        this.pendingInteractions.delete(request.requestId);
        const ids = this.taskInteractions.get(taskId);
        ids?.delete(request.requestId);
        if (ids?.size === 0) this.taskInteractions.delete(taskId);
        if (reason) {
          try { this.emitInteraction(taskId, 'interaction:dismissed', { requestId: request.requestId, reason }); } catch { /* card still settles */ }
        }
        try { this.store.deletePendingInteraction(request.requestId); } catch { /* card still settles */ }
        resolve(decision);
      };
      onAbort = () => settle(dismissedDecision(request, 'session_aborted'), 'session_aborted');
      const entry: PendingInteraction = {
        taskId,
        request,
        createdAt: view.createdAt,
        resolve: (decision) => settle(decision, 'resolved'),
      };
      try { this.store.savePendingInteraction(taskId, request.requestId); } catch { /* card can still be answered in-memory */ }
      this.pendingInteractions.set(request.requestId, entry);
      const ids = this.taskInteractions.get(taskId) ?? new Set<string>();
      ids.add(request.requestId);
      this.taskInteractions.set(taskId, ids);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else {
        try { this.emitInteraction(taskId, 'interaction:request', { interaction: view }); } catch { /* card remains available in memory */ }
      }
    });
  }

  private handleInteractionDismissed(taskId: string, requestId: string, reason: string): void {
    const pending = this.pendingInteractions.get(requestId);
    if (!pending || pending.taskId !== taskId) return;
    pending.resolve(dismissedDecision(pending.request, reason));
  }

  private dismissTaskInteractions(taskId: string, reason: string): void {
    const ids = this.taskInteractions.get(taskId);
    if (!ids) return;
    for (const requestId of [...ids]) {
      const pending = this.pendingInteractions.get(requestId);
      if (pending) pending.resolve(dismissedDecision(pending.request, reason));
    }
  }

  async sendMessage(taskId: string, content: string, clientId: string, idempotencyKey?: string): Promise<MessageRecord> {
    if (typeof content !== 'string' || content.trim() === '' || content.length > MAX_MESSAGE_LENGTH) throw new Error('INVALID_MESSAGE');
    content = redactServerSecrets(content);
    const key = idempotencyKey?.trim() || randomUUID();
    if (key.length > 200) throw new Error('INVALID_IDEMPOTENCY_KEY');
    const keyHash = createHash('sha256').update(key).digest('hex');
    const bodyHash = createHash('sha256').update(`${taskId}\0${content}`).digest('hex');
    return this.serializeTask(taskId, async () => {
      const prior = this.store.getRequest(clientId, keyHash);
      if (prior) {
        if (prior.bodyHash !== bodyHash || prior.taskId !== taskId) throw new Error('IDEMPOTENCY_KEY_REUSED');
        if (prior.state === 'accepted') {
          const message = this.store.getMessageById(prior.messageId);
          if (message) return message;
        }
        throw new Error(prior.state === 'rejected' ? 'SEND_NOT_ACCEPTED' : 'OUTCOME_UNKNOWN');
      }
      const targetTask = this.store.getTask(taskId);
      if (!targetTask) throw new Error('TASK_NOT_FOUND');
      if (targetTask.status !== 'active') throw new Error('TASK_ARCHIVED');
      const messageId = randomUUID();
      if (!this.store.beginRequest(clientId, keyHash, bodyHash, taskId, messageId)) throw new Error('OUTCOME_UNKNOWN');
      let dispatchStarted = false;
      let turnStarted = false;
      try {
        const runtime = await this.openTask(taskId);
        const message = this.store.appendMessage({ id: messageId, taskId, role: 'user', kind: 'text', content, clientId, createdAt: Date.now() });
        const turnAttemptToken = (this.turnAttemptTokens.get(taskId) ?? 0) + 1;
        this.turnAttemptTokens.set(taskId, turnAttemptToken);
        this.stopRequested.delete(taskId);
        this.store.setTurn(taskId, 'running', messageId);
        turnStarted = true;
        dispatchStarted = true;
        const result = await runtime.session.send(content, { turnAttemptToken });
        if (!result.accepted) {
          this.store.deleteMessage(message.id);
          this.store.setTurn(taskId, 'idle');
          this.store.setRequestState(clientId, keyHash, 'rejected');
          throw new Error('SEND_NOT_ACCEPTED');
        }
        this.store.setRequestState(clientId, keyHash, 'accepted');
        const task = this.store.getTask(taskId);
        if (task?.title === 'New task') this.applyTaskUpdate(taskId, { title: titleFromPrompt(content) });
        else this.applyTaskUpdate(taskId, {});
        const record = this.store.appendEvent(taskId, 'message:created', message);
        for (const listener of this.listeners) listener({ taskId, event: { type: 'status', data: { message } }, record });
        return message;
      } catch (error) {
        const state = (error instanceof Error && error.message === 'SEND_NOT_ACCEPTED') || !dispatchStarted ? 'rejected' : 'unknown';
        if (turnStarted && this.store.getTurn(taskId)?.state === 'running') {
          this.store.setTurn(taskId, dispatchStarted ? 'unknown' : 'idle');
        }
        this.store.setRequestState(clientId, keyHash, state);
        throw error;
      }
    });
  }

  async stopTask(taskId: string): Promise<void> {
    await this.serializeTask(taskId, async () => {
      const task = this.store.getTask(taskId);
      if (!task) throw new Error('TASK_NOT_FOUND');
      if (task.status !== 'active') throw new Error('TASK_ARCHIVED');
      const turnState = this.getTurnState(taskId);
      if (turnState !== 'running' && turnState !== 'unknown') return;
      const runtime = this.active.get(taskId);
      if (!runtime) {
        this.store.setTurn(taskId, 'unknown');
        this.store.appendEvent(taskId, 'task:interrupted', { state: 'unknown' });
        return;
      }
      this.stopRequested.add(taskId);
      this.dismissTaskInteractions(taskId, 'turn_stopped');
      try { await runtime.session.abort(); } catch (error) { this.stopRequested.delete(taskId); throw error; }
      this.store.setTurn(taskId, 'interrupted');
      const record = this.store.appendEvent(taskId, 'task:stopped', { state: 'interrupted' });
      for (const listener of this.listeners) listener({ taskId, event: { type: 'status', data: { status: 'interrupted' } }, record });
    });
  }

  private applyTaskUpdate(id: string, patch: Partial<Pick<TaskRecord, 'title' | 'status'>>): TaskRecord | null {
    const updated = this.store.updateTask(id, patch);
    if (updated) {
      const record = this.store.appendEvent(id, 'task:updated', updated);
      for (const listener of this.listeners) listener({ taskId: id, event: { type: 'status', data: { task: updated } }, record });
    }
    return updated;
  }

  async updateTask(id: string, patch: Partial<Pick<TaskRecord, 'title' | 'status'>>): Promise<TaskRecord | null> {
    return this.serializeTask(id, async () => {
      const task = this.store.getTask(id);
      if (!task) return null;
      if (patch.status === 'archived' && this.getTurnState(id) === 'running') throw new Error('TASK_BUSY');
      return this.applyTaskUpdate(id, patch);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const taskId of this.active.keys()) this.dismissTaskInteractions(taskId, 'server_shutdown');
    await Promise.allSettled([...this.taskQueues.values()]);
    for (const [taskId, runtime] of this.active) {
      this.dismissTaskInteractions(taskId, 'server_shutdown');
      for (const unsubscribe of runtime.unsubscribers) unsubscribe();
      await runtime.session.close().catch(() => undefined);
    }
    this.active.clear();
    try { await this.shutdownRuntime(); } finally { this.store.close(); }
  }
}
