/** Stable browser/headless HTTP contract v1. See docs/web-client-headless-contract.md. */

export interface ServerCapabilities {
  agents: AgentCapability[];
  defaultWorkspace: string;
}

export interface AgentCapability {
  id: 'claude-code' | 'codex' | 'pi' | string;
  label: string;
  models: string[];
  efforts: string[];
  permissionModes: string[];
}

export type ExposureStatus =
  | 'disabled'
  | 'loopback-only'
  | 'verifying'
  | 'ready'
  | 'unavailable'
  | 'error';

export interface ServerExposure {
  mode: 'loopback' | 'tailscale';
  status: ExposureStatus;
  url?: string;
  detail?: string | null;
}

export interface ServerInfo {
  version: string;
  startedAt: number;
  exposure: ServerExposure;
  capabilities: ServerCapabilities;
}

export interface ClientIdentity {
  id: string;
  label: string;
}

export interface SessionResponse {
  client: ClientIdentity;
  csrfToken: string;
  sessionExpiresAt: number;
  server: ServerInfo;
}

export interface PairingRequest {
  requestId: string;
  expiresAt: number;
}

export type PairingStatus = 'pending' | 'approved' | 'expired' | 'revoked';

export interface PairingApproved {
  status: 'approved';
  client: ClientIdentity;
  csrfToken: string;
  sessionExpiresAt: number;
}

export interface PairingPending {
  status: 'pending' | 'expired' | 'revoked';
}

export type PairingPollResult = PairingApproved | PairingPending;

export interface Task {
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
  /** Optional headless-server turn state; unknown values must be ignored. */
  turnState?: 'idle' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown' | string;
}

export interface Message {
  seq: number;
  id: string;
  taskId: string;
  role: 'user' | 'assistant' | 'system';
  kind: 'text' | 'error' | 'notice';
  content: string;
  clientId?: string;
  createdAt: number;
}

export interface TaskSnapshot {
  task: Task;
  messages: Message[];
  /** SSE event cursor (server `server_events.seq`), not the message cursor. */
  cursor: number;
  eventCursor?: number;
  messageCursor?: number;
  streaming: { text: string; kind: string } | null;
  /** True while the current turn is running, even when no text is streaming. */
  running?: boolean;
  /** Pending user decisions owned by this task. */
  interactions?: PendingInteraction[];
}

export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export type InteractionRequest =
  | {
      requestId: string;
      kind: 'permission';
      toolName: string;
      input?: Record<string, unknown>;
      title?: string;
      displayName?: string;
      description?: string;
      createdAt?: number;
    }
  | {
      requestId: string;
      kind: 'ask_user_question';
      questions: AskUserQuestionItem[];
      delivery?: 'async';
      createdAt?: number;
    }
  | {
      requestId: string;
      kind: 'plan_review';
      plan: string;
      planFilePath?: string;
      createdAt?: number;
    };

export interface PendingInteraction {
  request: InteractionRequest;
  createdAt?: number;
}

export type InteractionDecisionInput =
  | {
      kind: 'permission';
      behavior: 'allow' | 'deny';
      /** Server maps session scope to its vendor permission update. */
      scope?: 'once' | 'session';
      reason?: string;
    }
  | {
      kind: 'ask_user_question';
      answers: Record<string, string>;
    }
  | {
      kind: 'plan_review';
      behavior: 'allow' | 'deny';
      editedPlan?: string;
      reason?: string;
    };

export interface InteractionResolveResult {
  accepted: boolean;
}

export interface TaskListResponse {
  tasks: Task[];
  nextCursor: string | null;
}

export interface MessagePage {
  messages: Message[];
  cursor: number;
}

export interface CreateTaskInput {
  title?: string;
  workspace?: string;
  agentKind?: string;
  model?: string;
  provider?: string;
  effort?: string;
  permissionMode?: string;
}

export interface TaskEventEnvelope {
  seq: number;
  taskId: string;
  type: string;
  data: unknown;
  createdAt: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export interface TaskEventHandlers {
  onReady?: (cursor: number) => void;
  onMessage?: (message: Message, eventSeq: number) => void;
  onAgent?: (event: TaskEventEnvelope) => void;
  onTask?: (task: Task) => void;
  onInteraction?: (interaction: PendingInteraction) => void;
  onInteractionDismissed?: (requestId: string) => void;
  onServerError?: (error: { code: string; message: string }) => void;
  onReset?: (cursor: number) => void;
  onConnection?: (state: 'open' | 'closed') => void;
}
