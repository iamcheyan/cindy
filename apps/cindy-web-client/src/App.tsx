import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CreateTaskInput,
  InteractionDecisionInput,
  Message,
  PendingInteraction,
  SessionResponse,
  Task,
  TaskEventEnvelope,
  TaskSnapshot,
} from './contract';
import { ApiError, WebTransport } from './api';
import { translate, type Locale } from './i18n';
import { useCopy, useLocale, useRoute, useTheme, navigate } from './hooks';
import { PairingView } from './components/PairingView';
import { Sidebar, type TaskFilter } from './components/Sidebar';
import { TaskView } from './components/TaskView';
import { NewTaskView } from './components/NewTaskView';
import { ScopePanel } from './components/ScopePanel';
import { LocaleSelect, ThemeControl } from './components/Controls';
import { clearAllTaskDrafts, clearNewTaskDraft } from './drafts';
import { CloseIcon, MenuIcon, PlusIcon, SparkIcon } from './icons';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'error'; message: string }
  | { status: 'ready'; session: SessionResponse };

function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.seq - right.seq);
}

function mergeTasks(current: Task[], incoming: Task[]): Task[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((task) => [task.id, task]));
  for (const task of incoming) byId.set(task.id, task);
  return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

function taskMatchesFilter(task: Task, filter: TaskFilter): boolean {
  return filter === 'all' || task.status === filter;
}

function snapshotEventCursor(snapshot: TaskSnapshot): number {
  return snapshot.eventCursor ?? snapshot.cursor;
}

function textDelta(event: TaskEventEnvelope): { text: string; final: boolean } | null {
  if (event.type !== 'text' && event.type !== 'thinking') return null;
  const data = event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : {};
  const text =
    typeof data.text === 'string'
      ? data.text
      : typeof data.content === 'string'
        ? data.content
        : typeof data.delta === 'string'
          ? data.delta
          : null;
  if (!text) return null;
  return { text, final: data.isFinal === true };
}

export function App() {
  const transport = useRef(new WebTransport()).current;
  const { locale, setLocale } = useLocale();
  const { preference: theme, setPreference: setTheme } = useTheme();
  const route = useRoute();
  const t = useCallback(
    (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
      translate(locale, key, params),
    [locale],
  );

  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [nextTaskCursor, setNextTaskCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskFilter>('active');
  const [tasksLoading, setTasksLoading] = useState(false);
  const [loadingMoreTasks, setLoadingMoreTasks] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<TaskSnapshot | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState<{ text: string; kind: string } | null>(null);
  const [activity, setActivity] = useState(false);
  const [running, setRunning] = useState(false);
  const [connection, setConnection] = useState<'open' | 'closed'>('closed');
  const [taskError, setTaskError] = useState<string | null>(null);
  const [interactions, setInteractions] = useState<PendingInteraction[]>([]);
  const [busyInteractionId, setBusyInteractionId] = useState<string | null>(null);
  const [interactionError, setInteractionError] = useState<string | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const session = auth.status === 'ready' ? auth.session : null;
  const cursorRef = useRef(0);
  const taskIdRef = useRef<string | null>(null);
  const pendingSendRef = useRef<{ content: string; key: string } | null>(null);
  const filterRef = useRef<TaskFilter>('active');
  const refreshTimerRef = useRef<number | null>(null);
  const { copy } = useCopy();

  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

  const describeError = useCallback(
    (error: unknown): string => {
      if (error instanceof ApiError) {
        switch (error.code) {
          case 'UNAUTHORIZED':
            return t('error.unauthorized');
          case 'CSRF_FAILED':
            return t('error.csrf');
          case 'TASK_NOT_FOUND':
            return t('error.notFound');
          case 'RATE_LIMITED':
            return t('error.rateLimited');
          case 'SERVER_STARTING':
          case 'RUNTIME_UNAVAILABLE':
            return t('error.serverStarting');
          case 'SEND_NOT_ACCEPTED':
            return t('error.sendRejected');
          default:
            return error.message || t('error.generic');
        }
      }
      if (error instanceof TypeError) return t('error.network');
      return error instanceof Error && error.message ? error.message : t('error.generic');
    },
    [t],
  );

  const loadSession = useCallback(async () => {
    setAuth({ status: 'loading' });
    try {
      const next = await transport.getSession();
      setAuth({ status: 'ready', session: next });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setAuth({ status: 'anonymous' });
      } else {
        setAuth({ status: 'error', message: describeError(error) });
      }
    }
  }, [transport, describeError]);

  useEffect(() => {
    void loadSession();
    // Bootstrap once; locale changes only affect rendered error copy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadTasks = useCallback(
    async (nextFilter: TaskFilter = filter, append = false) => {
      if (!session) return;
      if (append) setLoadingMoreTasks(true);
      else setTasksLoading(true);
      try {
        const page = await transport.listTasks(nextFilter, append ? nextTaskCursor : null);
        setTasks((previous) => (append ? mergeTasks(previous, page.tasks) : page.tasks));
        setNextTaskCursor(page.nextCursor);
        setBanner(null);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          setAuth({ status: 'anonymous' });
          return;
        }
        setBanner(describeError(error));
      } finally {
        if (append) setLoadingMoreTasks(false);
        else setTasksLoading(false);
      }
    },
    [session, filter, nextTaskCursor, transport, describeError],
  );

  useEffect(() => {
    if (session) void loadTasks(filter, false);
    // loadTasks changes with filter/cursor; first page reload is keyed by filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, filter]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => void loadTasks(filter, false), 30_000);
    return () => window.clearInterval(timer);
  }, [session, filter, loadTasks]);

  const loadMoreTasks = useCallback(async () => {
    if (!nextTaskCursor || loadingMoreTasks) return;
    await loadTasks(filter, true);
  }, [nextTaskCursor, loadingMoreTasks, loadTasks, filter]);

  const refreshSnapshot = useCallback(
    async (taskId: string) => {
      try {
        const next = await transport.getTask(taskId);
        setSnapshot(next);
        setMessages((previous) => mergeMessages(next.messages, previous));
        setStreaming((previous) => next.streaming ?? previous);
        const nextRunning = next.task.turnState
          ? next.task.turnState === 'running'
          : (next.running ?? Boolean(next.streaming));
        setRunning(nextRunning);
        cursorRef.current = Math.max(cursorRef.current, snapshotEventCursor(next));
        setInteractions(next.interactions ?? []);
        setTaskError(null);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          setAuth({ status: 'anonymous' });
          return;
        }
        if (error instanceof ApiError && error.code === 'TASK_NOT_FOUND') {
          setSnapshot(null);
          setTaskError(t('error.notFound'));
          return;
        }
        setTaskError(describeError(error));
      }
    },
    [transport, describeError, t],
  );

  useEffect(() => {
    if (!session || route.view !== 'task') {
      taskIdRef.current = null;
      setSnapshot(null);
      setMessages([]);
      setStreaming(null);
      setActivity(false);
      setRunning(false);
      setTaskError(null);
      setInteractions([]);
      setBusyInteractionId(null);
      setInteractionError(null);
      setConnection('closed');
      return;
    }
    const taskId = route.taskId;
    taskIdRef.current = taskId;
    let cancelled = false;
    const controller = new AbortController();
    setTaskLoading(true);
    setSnapshot(null);
    setMessages([]);
    setStreaming(null);
    setActivity(false);
    setRunning(false);
    setTaskError(null);
    setInteractions([]);
    setBusyInteractionId(null);
    setInteractionError(null);
    setConnection('closed');

    const hydrateMessages = async (next: TaskSnapshot) => {
      if (next.messages.length < 200) return;
      let after = next.messageCursor ?? next.messages[next.messages.length - 1]?.seq ?? 0;
      let merged = next.messages;
      for (let page = 0; page < 10; page += 1) {
        const result = await transport.listMessages(taskId, after, 200);
        if (cancelled || result.messages.length === 0) break;
        merged = mergeMessages(merged, result.messages);
        after = result.cursor;
        if (result.messages.length < 200) break;
      }
      if (!cancelled) setMessages((previous) => mergeMessages(merged, previous));
    };

    const applySnapshot = (next: TaskSnapshot) => {
      setSnapshot(next);
      setMessages((previous) => mergeMessages(next.messages, previous));
      setStreaming((previous) => next.streaming ?? previous);
      const nextRunning = next.task.turnState
        ? next.task.turnState === 'running'
        : (next.running ?? Boolean(next.streaming));
      setRunning(nextRunning);
      cursorRef.current = Math.max(cursorRef.current, snapshotEventCursor(next));
      setInteractions(next.interactions ?? []);
      setTasks((previous) => previous.map((task) => (task.id === next.task.id ? next.task : task)));
    };

    const scheduleRefresh = () => {
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        if (!cancelled && taskIdRef.current === taskId) void refreshSnapshot(taskId);
      }, 300);
    };

    let closeEvents: (() => void) | null = null;
    let openedOnce = false;

    const startEvents = (after: number) => {
      closeEvents = transport.subscribeTaskEvents(taskId, after, {
      onReady: (cursor) => {
        if (cancelled) return;
        cursorRef.current = Math.max(cursorRef.current, cursor);
        setConnection('open');
      },
      onConnection: (state) => {
        if (cancelled) return;
        setConnection(state);
        if (state === 'open') {
          if (openedOnce) scheduleRefresh();
          openedOnce = true;
        }
      },
      onMessage: (message, eventSeq) => {
        if (cancelled) return;
        if (eventSeq > 0) cursorRef.current = Math.max(cursorRef.current, eventSeq);
        setMessages((previous) => mergeMessages(previous, [message]));
        if (message.role === 'assistant') {
          setStreaming(null);
          setActivity(false);
        }
      },
      onAgent: (event) => {
        if (cancelled) return;
        cursorRef.current = Math.max(cursorRef.current, event.seq);
        const delta = textDelta(event);
        if (delta) {
          setStreaming((previous) => {
            const base = previous && previous.kind === event.type ? previous.text : '';
            return { kind: event.type, text: delta.final ? delta.text : `${base}${delta.text}` };
          });
          return;
        }
        if (event.type === 'tool_use') setActivity(true);
        if (event.type === 'tool_result') setActivity(false);
        if (event.type === 'status') {
          const data = event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : {};
          setActivity(data.isRunning === true);
        }
        if (event.type === 'done') {
          setRunning(false);
          setActivity(false);
          setStreaming(null);
          scheduleRefresh();
        }
        if (event.type === 'error') {
          const data = event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : {};
          setRunning(false);
          setActivity(false);
          setStreaming(null);
          setTaskError(typeof data.message === 'string' ? data.message : t('error.generic'));
          scheduleRefresh();
        }
      },
      onTask: (task) => {
        if (cancelled) return;
        setSnapshot((previous) => (previous ? { ...previous, task } : previous));
        setTasks((previous) => {
          const exists = previous.some((item) => item.id === task.id);
          const next = exists ? previous.map((item) => (item.id === task.id ? task : item)) : [task, ...previous];
          return next.filter((item) => taskMatchesFilter(item, filterRef.current));
        });
      },
      onInteraction: (interaction) => {
        if (cancelled) return;
        setInteractions((previous) => {
          const next = previous.filter((item) => item.request.requestId !== interaction.request.requestId);
          return [...next, interaction];
        });
        setInteractionError(null);
      },
      onInteractionDismissed: (requestId) => {
        if (cancelled) return;
        setInteractions((previous) => previous.filter((item) => item.request.requestId !== requestId));
      },
      onServerError: (error) => {
        if (!cancelled) setTaskError(error.message || t('error.generic'));
      },
      onReset: (cursor) => {
        if (cancelled) return;
        cursorRef.current = Math.max(cursorRef.current, cursor);
        scheduleRefresh();
      },
      });
    };

    transport
      .getTask(taskId, controller.signal)
      .then((next) => {
        if (cancelled) return;
        applySnapshot(next);
        void hydrateMessages(next).catch(() => undefined);
        startEvents(snapshotEventCursor(next));
        setTaskLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setTaskLoading(false);
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          setAuth({ status: 'anonymous' });
          return;
        }
        if (error instanceof ApiError && error.code === 'TASK_NOT_FOUND') {
          setTaskError(t('error.notFound'));
          return;
        }
        setTaskError(describeError(error));
      });

    return () => {
      cancelled = true;
      controller.abort();
      closeEvents?.();
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
    // route.taskId is the identity; locale/filter changes must not reconnect the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, route.view === 'task' ? route.taskId : null]);

  useEffect(() => {
    if (route.view !== 'task') setSidebarOpen(false);
  }, [route]);

  useEffect(() => {
    if (!session) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void loadTasks(filter, false);
      if (route.view === 'task') void refreshSnapshot(route.taskId);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [session, filter, route, loadTasks, refreshSnapshot]);

  useEffect(() => {
    document.title = snapshot?.task.title ? `${snapshot.task.title} · Cindy` : 'Cindy';
  }, [snapshot?.task.title]);

  useEffect(() => {
    if (!copiedUrl) return;
    const timer = window.setTimeout(() => setCopiedUrl(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copiedUrl]);

  const selectedTaskId = route.view === 'task' ? route.taskId : null;

  const selectTask = (task: Task) => {
    navigate({ view: 'task', taskId: task.id });
    setSidebarOpen(false);
  };

  const createTask = async (input: CreateTaskInput) => {
    setCreating(true);
    setCreateError(null);
    try {
      const task = await transport.createTask(input);
      clearNewTaskDraft();
      setTasks((previous) => [task, ...previous.filter((item) => item.id !== task.id)]);
      setFilter('active');
      navigate({ view: 'task', taskId: task.id });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setAuth({ status: 'anonymous' });
        return;
      }
      setCreateError(describeError(error));
    } finally {
      setCreating(false);
    }
  };

  const applyTask = (task: Task) => {
    setSnapshot((previous) => (previous ? { ...previous, task } : previous));
    setTasks((previous) => {
      const exists = previous.some((item) => item.id === task.id);
      const next = exists ? previous.map((item) => (item.id === task.id ? task : item)) : [task, ...previous];
      return next.filter((item) => taskMatchesFilter(item, filterRef.current));
    });
  };

  const renameTask = async (title: string): Promise<boolean> => {
    if (!selectedTaskId) return false;
    try {
      const task = await transport.updateTask(selectedTaskId, { title });
      applyTask(task);
      setTaskError(null);
      return true;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setAuth({ status: 'anonymous' });
        return false;
      }
      setTaskError(describeError(error));
      return false;
    }
  };

  const archiveTask = async (status: 'active' | 'archived') => {
    if (!selectedTaskId) return;
    try {
      const task = await transport.updateTask(selectedTaskId, { status });
      applyTask(task);
      setTaskError(null);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setAuth({ status: 'anonymous' });
        return;
      }
      setTaskError(describeError(error));
    }
  };

  const resolveInteraction = async (requestId: string, decision: InteractionDecisionInput) => {
    if (!selectedTaskId || busyInteractionId) return;
    const target = interactions.find((item) => item.request.requestId === requestId);
    setBusyInteractionId(requestId);
    setInteractionError(null);
    setInteractions((current) => current.filter((item) => item.request.requestId !== requestId));
    const restore = () => {
      if (!target) return;
      setInteractions((current) =>
        current.some((item) => item.request.requestId === requestId) ? current : [...current, target],
      );
    };
    try {
      const result = await transport.resolveInteraction(selectedTaskId, requestId, decision);
      if (!result.accepted) {
        restore();
        setInteractionError(t('interaction.error'));
      }
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setAuth({ status: 'anonymous' });
        return;
      }
      restore();
      setInteractionError(describeError(error));
    } finally {
      setBusyInteractionId(null);
    }
  };

  const send = async (content: string): Promise<boolean> => {
    if (!selectedTaskId) return false;
    setSending(true);
    setTaskError(null);
    const pending = pendingSendRef.current;
    const key = pending?.content === content ? pending.key : crypto.randomUUID();
    pendingSendRef.current = { content, key };
    try {
      const message = await transport.sendMessage(selectedTaskId, content, key);
      pendingSendRef.current = null;
      setMessages((previous) => mergeMessages(previous, [message]));
      setRunning(true);
      setStreaming(null);
      setTasks((previous) =>
        previous.map((task) =>
          task.id === selectedTaskId
            ? { ...task, title: task.title === 'New task' ? content.slice(0, 80) : task.title, updatedAt: Date.now() }
            : task,
        ),
      );
      return true;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setAuth({ status: 'anonymous' });
        return false;
      }
      setTaskError(describeError(error));
      return false;
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!selectedTaskId || stopping) return;
    setStopping(true);
    try {
      await transport.stopTask(selectedTaskId);
      setRunning(false);
      setActivity(false);
      setStreaming(null);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setAuth({ status: 'anonymous' });
        return;
      }
      setTaskError(describeError(error));
    } finally {
      setStopping(false);
    }
  };

  const logout = async () => {
    try {
      await transport.logout();
    } finally {
      clearAllTaskDrafts();
      setAuth({ status: 'anonymous' });
      setTasks([]);
      setSnapshot(null);
      setMessages([]);
      navigate({ view: 'tasks' });
    }
  };

  const exposureUrl = session?.server.exposure.status === 'ready' ? session.server.exposure.url : undefined;

  const copyExposure = async () => {
    if (!exposureUrl) return;
    await copy(exposureUrl);
    setCopiedUrl(true);
  };

  const renderMain = () => {
    if (!session) return null;
    if (route.view === 'new') {
      return (
        <NewTaskView
          capabilities={session.server.capabilities}
          locale={locale}
          creating={creating}
          error={createError}
          onCreate={(input) => void createTask(input)}
          onCancel={() => navigate({ view: 'tasks' })}
        />
      );
    }
    if (route.view === 'task') {
      if (!snapshot) {
        return (
          <div className="center-state" role="status">
            {taskLoading ? <span className="spinner" aria-hidden /> : null}
            <p>{taskError ?? (taskLoading ? t('common.loading') : t('error.notFound'))}</p>
          </div>
        );
      }
      return (
        <TaskView
          key={snapshot.task.id}
          task={snapshot.task}
          messages={messages}
          streaming={streaming}
          activity={activity}
          running={running}
          sending={sending}
          stopping={stopping}
          connection={connection}
          locale={locale}
          error={taskError}
          interactions={interactions}
          busyInteractionId={busyInteractionId}
          interactionError={interactionError}
          onResolveInteraction={(requestId, decision) => void resolveInteraction(requestId, decision)}
          onSend={send}
          onStop={() => void stop()}
          onRename={renameTask}
          onArchive={archiveTask}
          onBack={() => navigate({ view: 'tasks' })}
        />
      );
    }
    return (
      <section className="home-view" aria-labelledby="home-title">
        <button
          type="button"
          className="icon-button mobile-menu"
          aria-label={t('a11y.openSidebar')}
          title={t('a11y.openSidebar')}
          onClick={() => setSidebarOpen(true)}
        >
          <MenuIcon size={20} />
        </button>
        <div className="home-hero">
          <span className="home-mark" aria-hidden>
            <SparkIcon size={24} />
          </span>
          <h1 id="home-title">Cindy</h1>
          <p className="muted">{t('new.description')}</p>
          <button type="button" className="primary-button" onClick={() => navigate({ view: 'new' })}>
            <PlusIcon size={16} />
            {t('nav.newTask')}
          </button>
          {tasks.length > 0 ? (
            <div className="recent-tasks">
              <h2>{t('nav.tasks')}</h2>
              {tasks.slice(0, 5).map((task) => (
                <button key={task.id} type="button" className="recent-task" onClick={() => selectTask(task)}>
                  <span>{task.title || t('tasks.untitled')}</span>
                  <span className="muted">{task.agentKind}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {exposureUrl ? (
          <div className="exposure-card">
            <div>
              <p className="exposure-card-title">{t('server.exposure.ready')}</p>
              <p className="exposure-card-url">{exposureUrl}</p>
            </div>
            <button type="button" className="secondary-button" onClick={() => void copyExposure()}>
              {copiedUrl ? t('server.copied') : t('server.copy')}
            </button>
          </div>
        ) : null}
      </section>
    );
  };

  const mainContent = renderMain();
  const authControls = (
    <div className="auth-controls">
      <LocaleSelect locale={locale} onLocale={setLocale} compact />
      <ThemeControl locale={locale} theme={theme} onTheme={setTheme} />
    </div>
  );

  if (auth.status === 'loading') {
    return (
      <div className="center-state center-state--full" role="status">
        <span className="spinner" aria-hidden />
        <p>{t('common.loading')}</p>
      </div>
    );
  }

  if (auth.status === 'error') {
    return (
      <>
        <main className="pairing-shell">
          <section className="pairing-card">
            <div className="pairing-mark" aria-hidden>
              <SparkIcon size={22} />
            </div>
            <h1>{t('error.network')}</h1>
            <p className="muted">{auth.message}</p>
            <button type="button" className="primary-button" onClick={() => void loadSession()}>
              {t('common.retry')}
            </button>
          </section>
        </main>
        {authControls}
      </>
    );
  }

  if (auth.status === 'anonymous') {
    return (
      <>
        <PairingView transport={transport} locale={locale} onApproved={(next) => setAuth({ status: 'ready', session: next })} />
        {authControls}
      </>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        session={auth.session}
        tasks={tasks}
        selectedTaskId={selectedTaskId}
        filter={filter}
        loading={tasksLoading}
        hasMore={Boolean(nextTaskCursor)}
        loadingMore={loadingMoreTasks}
        open={sidebarOpen}
        locale={locale}
        theme={theme}
        onFilter={(next) => {
          setFilter(next);
          setNextTaskCursor(null);
        }}
        onSelect={selectTask}
        onNew={() => {
          navigate({ view: 'new' });
          setSidebarOpen(false);
        }}
        onRefresh={() => {
          void loadTasks();
          if (selectedTaskId) void refreshSnapshot(selectedTaskId);
        }}
        onLoadMore={() => void loadMoreTasks()}
        onScope={() => setScopeOpen(true)}
        onLogout={() => void logout()}
        onClose={() => setSidebarOpen(false)}
        onLocale={setLocale}
        onTheme={setTheme}
      />
      <main className="main-panel" aria-label={t('a11y.main')}>
        {banner ? (
          <div className="app-banner" role="alert">
            <span>{banner}</span>
            <button type="button" className="icon-button" aria-label={t('common.dismiss')} onClick={() => setBanner(null)}>
              <CloseIcon size={16} />
            </button>
          </div>
        ) : null}
        {mainContent}
      </main>
      {scopeOpen ? <ScopePanel locale={locale} onClose={() => setScopeOpen(false)} /> : null}
    </div>
  );
}

export type { Locale };
