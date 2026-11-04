const PREFIX = 'cindy.web.draft.';
const NEW_TASK_KEY = 'cindy.web.new-task-draft';
const MAX_DRAFT_CHARS = 64_000;

function storageKey(taskId: string): string {
  return `${PREFIX}${taskId}`;
}

export function readTaskDraft(taskId: string): string {
  try {
    return sessionStorage.getItem(storageKey(taskId)) ?? '';
  } catch {
    return '';
  }
}

export function writeTaskDraft(taskId: string, value: string): void {
  try {
    const key = storageKey(taskId);
    if (!value.trim()) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, value.slice(0, MAX_DRAFT_CHARS));
  } catch {
    // A blocked storage context must not break composing.
  }
}

export function clearTaskDraft(taskId: string): void {
  try {
    sessionStorage.removeItem(storageKey(taskId));
  } catch {
    // Ignore storage failures.
  }
}

export function clearAllTaskDrafts(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
    sessionStorage.removeItem(NEW_TASK_KEY);
  } catch {
    // Ignore storage failures.
  }
}


export interface NewTaskDraft {
  title: string;
  workspace: string;
  agentId: string;
  model: string;
  effort: string;
  permission: string;
}

export function readNewTaskDraft(): Partial<NewTaskDraft> {
  try {
    const raw = sessionStorage.getItem(NEW_TASK_KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as Partial<NewTaskDraft>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const text = (input: unknown) => (typeof input === 'string' ? input : '');
    return {
      title: text(value.title),
      workspace: text(value.workspace),
      agentId: text(value.agentId),
      model: text(value.model),
      effort: text(value.effort),
      permission: text(value.permission),
    };
  } catch {
    return {};
  }
}

export function writeNewTaskDraft(draft: NewTaskDraft): void {
  try {
    sessionStorage.setItem(NEW_TASK_KEY, JSON.stringify({
      title: draft.title.slice(0, 200),
      workspace: draft.workspace.slice(0, 4096),
      agentId: draft.agentId.slice(0, 80),
      model: draft.model.slice(0, 200),
      effort: draft.effort.slice(0, 40),
      permission: draft.permission.slice(0, 40),
    }));
  } catch {
    // A blocked storage context must not break the form.
  }
}

export function clearNewTaskDraft(): void {
  try {
    sessionStorage.removeItem(NEW_TASK_KEY);
  } catch {
    // Ignore storage failures.
  }
}
