import type {
  ApiErrorBody,
  CreateTaskInput,
  InteractionDecisionInput,
  InteractionResolveResult,
  Message,
  MessagePage,
  PairingPollResult,
  PairingRequest,
  PendingInteraction,
  SessionResponse,
  Task,
  TaskEventEnvelope,
  TaskEventHandlers,
  TaskListResponse,
  TaskSnapshot,
} from './contract';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  idempotencyKey?: string;
};

function relative(path: string): string {
  return path.replace(/^\/+/, '');
}

async function parseError(response: Response): Promise<ApiError> {
  let code = `HTTP_${response.status}`;
  let message = response.statusText || 'Request failed';
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    if (body.error && typeof body.error.code === 'string' && typeof body.error.message === 'string') {
      code = body.error.code;
      message = body.error.message;
    }
  } catch {
    // Non-JSON error bodies are deliberately not surfaced verbatim.
  }
  return new ApiError(response.status, code, message);
}

function asMessage(value: unknown): Message | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.message !== undefined) return asMessage(record.message);
  if (
    typeof record.id === 'string' &&
    typeof record.taskId === 'string' &&
    typeof record.seq === 'number' &&
    (record.role === 'user' || record.role === 'assistant' || record.role === 'system') &&
    typeof record.content === 'string'
  ) {
    return record as unknown as Message;
  }
  return record.data !== undefined ? asMessage(record.data) : null;
}

function asTask(value: unknown): Task | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.task !== undefined) return asTask(record.task);
  if (typeof record.id === 'string' && typeof record.title === 'string' && typeof record.status === 'string') {
    return record as unknown as Task;
  }
  return record.data !== undefined ? asTask(record.data) : null;
}

function normalizeAgentEnvelope(value: TaskEventEnvelope): TaskEventEnvelope {
  const payload = value.data;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return value;
  const record = payload as Record<string, unknown>;
  const inner = record.data;
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return value;
  const event = inner as Record<string, unknown>;
  return typeof event.type === 'string' ? { ...value, type: event.type, data: event.data } : value;
}

export class WebTransport {
  private csrfToken: string | null = null;

  setCsrfToken(token: string | null): void {
    this.csrfToken = token;
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    if (method !== 'GET' && this.csrfToken) headers['X-Cindy-CSRF'] = this.csrfToken;
    const response = await fetch(relative(path), {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: options.signal,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!response.ok) throw await parseError(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async getSession(signal?: AbortSignal): Promise<SessionResponse> {
    const session = await this.request<SessionResponse>('api/session', { signal });
    this.setCsrfToken(session.csrfToken);
    return session;
  }

  async requestPairing(label: string, signal?: AbortSignal): Promise<PairingRequest> {
    return this.request<PairingRequest>('api/auth/requests', {
      method: 'POST',
      body: { label },
      signal,
    });
  }

  async pollPairing(requestId: string, signal?: AbortSignal): Promise<PairingPollResult> {
    const result = await this.request<PairingPollResult>('api/auth/requests/status', {
      method: 'POST',
      body: { requestId },
      signal,
    });
    if (result.status === 'approved') this.setCsrfToken(result.csrfToken);
    return result;
  }

  async logout(): Promise<void> {
    await this.request<void>('api/auth/logout', { method: 'POST' });
    this.setCsrfToken(null);
  }

  async listTasks(
    status: 'active' | 'archived' | 'all' = 'active',
    cursor?: string | null,
  ): Promise<TaskListResponse> {
    const query = new URLSearchParams({ status, limit: '100' });
    if (cursor) query.set('cursor', cursor);
    return this.request<TaskListResponse>(`api/tasks?${query.toString()}`);
  }

  async getTask(id: string, signal?: AbortSignal): Promise<TaskSnapshot> {
    return this.request<TaskSnapshot>(`api/tasks/${encodeURIComponent(id)}`, { signal });
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const response = await this.request<{ task: Task }>('api/tasks', {
      method: 'POST',
      body: input,
    });
    return response.task;
  }

  async updateTask(id: string, patch: { title?: string; status?: 'active' | 'archived' }): Promise<Task> {
    const response = await this.request<{ task: Task }>(`api/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    });
    return response.task;
  }

  async sendMessage(id: string, content: string, idempotencyKey?: string): Promise<Message> {
    const response = await this.request<{ message: Message }>(
      `api/tasks/${encodeURIComponent(id)}/messages`,
      { method: 'POST', body: { content }, ...(idempotencyKey ? { idempotencyKey } : {}) },
    );
    return response.message;
  }

  async stopTask(id: string): Promise<void> {
    await this.request<{ ok: true }>(`api/tasks/${encodeURIComponent(id)}/stop`, { method: 'POST' });
  }

  async listInteractions(id: string): Promise<PendingInteraction[]> {
    const response = await this.request<{ interactions: PendingInteraction[] }>(
      `api/tasks/${encodeURIComponent(id)}/interactions`,
    );
    return response.interactions;
  }

  async resolveInteraction(
    id: string,
    requestId: string,
    decision: InteractionDecisionInput,
  ): Promise<InteractionResolveResult> {
    return this.request<InteractionResolveResult>(
      `api/tasks/${encodeURIComponent(id)}/interactions/${encodeURIComponent(requestId)}`,
      { method: 'POST', body: { decision } },
    );
  }

  async listMessages(id: string, after: number, limit = 200): Promise<MessagePage> {
    return this.request<MessagePage>(
      `api/tasks/${encodeURIComponent(id)}/messages?after=${after}&limit=${limit}`,
    );
  }

  /**
   * Subscribe to a task's live events. EventSource sends cookies automatically;
   * the server must enforce same-origin. The browser's own reconnect sends
   * Last-Event-ID, and the explicit `after` covers the first connection.
   */
  subscribeTaskEvents(
    id: string,
    after: number,
    handlers: TaskEventHandlers,
  ): () => void {
    const source = new EventSource(
      relative(`api/tasks/${encodeURIComponent(id)}/events?after=${after}`),
    );
    let closed = false;

    const parse = <T>(event: MessageEvent<string>): T | null => {
      try {
        return JSON.parse(event.data) as T;
      } catch {
        return null;
      }
    };

    const onOpen = () => handlers.onConnection?.('open');
    const onNativeError = (event: Event) => {
      if (event instanceof MessageEvent && typeof event.data === 'string' && event.data) {
        try {
          const payload = JSON.parse(event.data) as { code: string; message: string };
          handlers.onServerError?.(payload);
          return;
        } catch {
          // Fall through to connection handling for malformed payloads.
        }
      }
      handlers.onConnection?.('closed');
    };
    const onReady = (event: MessageEvent<string>) => {
      const payload = parse<{ cursor: number }>(event);
      if (payload && Number.isFinite(payload.cursor)) handlers.onReady?.(payload.cursor);
    };
    const onMessage = (event: MessageEvent<string>) => {
      const payload = parse<unknown>(event);
      const message = asMessage(payload);
      if (!message) return;
      const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
      const eventSeq = record && typeof record.seq === 'number' && record.data !== undefined ? record.seq : 0;
      handlers.onMessage?.(message, eventSeq);
    };
    const onAgent = (event: MessageEvent<string>) => {
      const payload = parse<TaskEventEnvelope>(event);
      if (payload) handlers.onAgent?.(normalizeAgentEnvelope(payload));
    };
    const onTask = (event: MessageEvent<string>) => {
      const payload = parse<unknown>(event);
      const task = asTask(payload);
      if (task) handlers.onTask?.(task);
    };
    const onInteraction = (event: MessageEvent<string>) => {
      const payload = parse<{ interaction: PendingInteraction }>(event);
      if (payload?.interaction) handlers.onInteraction?.(payload.interaction);
    };
    const onInteractionDismissed = (event: MessageEvent<string>) => {
      const payload = parse<{ requestId: string }>(event);
      if (payload?.requestId) handlers.onInteractionDismissed?.(payload.requestId);
    };
    const onServerError = (event: MessageEvent<string>) => {
      if (!event.data) return;
      const payload = parse<{ code: string; message: string }>(event);
      if (payload) handlers.onServerError?.(payload);
    };
    const onReset = (event: MessageEvent<string>) => {
      const payload = parse<{ cursor: number }>(event);
      handlers.onReset?.(payload?.cursor ?? 0);
    };

    source.addEventListener('open', onOpen);
    source.addEventListener('error', onNativeError);
    source.addEventListener('ready', onReady as EventListener);
    source.addEventListener('message', onMessage as EventListener);
    source.addEventListener('agent', onAgent as EventListener);
    source.addEventListener('task', onTask as EventListener);
    source.addEventListener('interaction', onInteraction as EventListener);
    source.addEventListener('interaction-dismissed', onInteractionDismissed as EventListener);
    source.addEventListener('server-error', onServerError as EventListener);
    source.addEventListener('reset', onReset as EventListener);

    return () => {
      if (closed) return;
      closed = true;
      source.removeEventListener('open', onOpen);
      source.removeEventListener('error', onNativeError);
      source.removeEventListener('ready', onReady as EventListener);
      source.removeEventListener('message', onMessage as EventListener);
      source.removeEventListener('agent', onAgent as EventListener);
      source.removeEventListener('task', onTask as EventListener);
      source.removeEventListener('interaction', onInteraction as EventListener);
      source.removeEventListener('interaction-dismissed', onInteractionDismissed as EventListener);
      source.removeEventListener('server-error', onServerError as EventListener);
      source.removeEventListener('reset', onReset as EventListener);
      source.close();
    };
  }
}
