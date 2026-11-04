import { useEffect, useRef, useState } from 'react';
import type { InteractionDecisionInput, Message, PendingInteraction, Task } from '../contract';
import { translate, type Locale } from '../i18n';
import { ChevronLeftIcon, MoreIcon, SendIcon, SparkIcon, StopIcon } from '../icons';
import { InteractionPanel } from './InteractionPanel';
import { clearTaskDraft, readTaskDraft, writeTaskDraft } from '../drafts';

interface TaskViewProps {
  task: Task;
  messages: Message[];
  streaming: { text: string; kind: string } | null;
  activity: boolean;
  running: boolean;
  sending: boolean;
  stopping: boolean;
  connection: 'open' | 'closed';
  locale: Locale;
  error: string | null;
  interactions: PendingInteraction[];
  busyInteractionId: string | null;
  interactionError: string | null;
  onResolveInteraction: (requestId: string, decision: InteractionDecisionInput) => void;
  onSend: (content: string) => Promise<boolean>;
  onStop: () => void;
  onRename: (title: string) => Promise<boolean>;
  onArchive: (status: 'active' | 'archived') => Promise<void>;
  onBack: () => void;
}

function timeLabel(locale: Locale, value: number): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function TaskView({
  task,
  messages,
  streaming,
  activity,
  running,
  sending,
  stopping,
  connection,
  locale,
  error,
  interactions,
  busyInteractionId,
  interactionError,
  onResolveInteraction,
  onSend,
  onStop,
  onRename,
  onArchive,
  onBack,
}: TaskViewProps) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const [draft, setDraft] = useState(() => readTaskDraft(task.id));
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const update = () => {
      stickRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    };
    scroller.addEventListener('scroll', update, { passive: true });
    return () => scroller.removeEventListener('scroll', update);
  }, []);

  useEffect(() => {
    if (!stickRef.current) return;
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streaming?.text, activity]);

  useEffect(() => {
    setTitleDraft(task.title);
  }, [task.title]);

  useEffect(() => {
    setMenuOpen(false);
    setRenaming(false);
    setActionError(null);
  }, [task.id]);

  const updateDraft = (value: string) => {
    setDraft(value);
    writeTaskDraft(task.id, value);
  };

  const beginRename = () => {
    setTitleDraft(task.title);
    setRenaming(true);
    setMenuOpen(false);
    setActionError(null);
  };

  const submitRename = async (event: React.FormEvent) => {
    event.preventDefault();
    const next = titleDraft.trim();
    if (!next || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    const saved = await onRename(next);
    setActionBusy(false);
    if (saved) setRenaming(false);
    else setActionError(t('error.generic'));
  };

  const toggleArchive = async () => {
    if (actionBusy) return;
    setMenuOpen(false);
    setActionBusy(true);
    setActionError(null);
    await onArchive(task.status === 'archived' ? 'active' : 'archived');
    setActionBusy(false);
  };

  const submit = async () => {
    const content = draft.trim();
    if (!content || sending || task.status === 'archived') return;
    const accepted = await onSend(content);
    if (accepted) {
      setDraft('');
      clearTaskDraft(task.id);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  return (
    <section className="task-view" aria-label={t('a11y.main')}>
      <header className="task-header">
        <button
          type="button"
          className="icon-button task-back"
          aria-label={t('task.back')}
          title={t('task.back')}
          onClick={onBack}
        >
          <ChevronLeftIcon size={18} />
        </button>
        <div className="task-heading">
          <h1>{task.title || t('tasks.untitled')}</h1>
          <div className="task-meta">
            <span className="meta-chip">{task.agentKind}</span>
            <span className="meta-chip">{task.model}</span>
            <span className="meta-chip">{task.permissionMode}</span>
            <span className={`live-state ${connection === 'open' ? 'live-state--on' : ''}`} aria-live="polite">
              <span className="status-dot" aria-hidden />
              {connection === 'open' ? t('task.live') : t('task.reconnecting')}
            </span>
          </div>
        </div>
        <div className="task-actions">
          {running || stopping ? (
            <button
              type="button"
              className="secondary-button stop-button"
              onClick={onStop}
              disabled={stopping}
              aria-label={t('a11y.stop')}
            >
              <StopIcon size={15} />
              {stopping ? t('task.stopping') : t('task.stop')}
            </button>
          ) : null}
          <button
            type="button"
            className="icon-button"
            aria-label={t('task.menu')}
            title={t('task.menu')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreIcon size={18} />
          </button>
          {menuOpen ? (
            <div className="task-menu" role="menu" aria-label={t('task.menu')}>
              <button type="button" role="menuitem" onClick={beginRename}>
                {t('task.rename')}
              </button>
              <button type="button" role="menuitem" onClick={() => void toggleArchive()} disabled={actionBusy}>
                {task.status === 'archived' ? t('task.unarchive') : t('task.archive')}
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {renaming ? (
        <form className="rename-bar" onSubmit={submitRename}>
          <label className="field">
            <span className="sr-only">{t('task.renameLabel')}</span>
            <input
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              maxLength={200}
              autoFocus
              aria-label={t('task.renameLabel')}
            />
          </label>
          <button type="submit" className="secondary-button" disabled={!titleDraft.trim() || actionBusy}>
            {t('task.save')}
          </button>
          <button type="button" className="secondary-button" onClick={() => setRenaming(false)} disabled={actionBusy}>
            {t('common.cancel')}
          </button>
        </form>
      ) : null}

      {actionError ? (
        <div className="inline-error task-action-error" role="alert">
          <p>{actionError}</p>
        </div>
      ) : null}

      {task.status === 'archived' ? (
        <div className="archived-banner" role="status">
          {t('filter.archived')} · {task.workspace}
        </div>
      ) : null}

      <div className="message-scroller" ref={scrollerRef}>
        <div className="message-column">
          {messages.length === 0 && !streaming ? (
            <div className="task-empty">
              <SparkIcon size={20} />
              <p>{t('task.empty')}</p>
              <p className="muted">{t('task.workspace')}: {task.workspace}</p>
            </div>
          ) : null}

          {messages.map((message) => (
            <article key={message.id} className={`message message--${message.role} ${message.kind === 'error' ? 'message--error' : ''}`}>
              <header className="message-header">
                <span className="message-author">
                  {message.role === 'user' ? t('message.you') : message.role === 'system' ? t('message.system') : t('message.assistant')}
                </span>
                <time dateTime={new Date(message.createdAt).toISOString()}>{timeLabel(locale, message.createdAt)}</time>
              </header>
              <div className="message-body">{message.content}</div>
            </article>
          ))}

          {streaming ? (
            <article className="message message--assistant message--streaming">
              <header className="message-header">
                <span className="message-author">{t('message.assistant')}</span>
                <span className="streaming-label">
                  <span className="spinner spinner--small" aria-hidden />
                  {t('status.running')}
                </span>
              </header>
              <div className="message-body">{streaming.text}<span className="caret" aria-hidden /></div>
            </article>
          ) : null}

          {activity ? (
            <div className="activity-row" aria-live="polite">
              <span className="spinner spinner--small" aria-hidden />
              <span>{t('status.running')}</span>
            </div>
          ) : null}

          {error ? (
            <div className="inline-error" role="alert">
              <strong>{t('task.error')}</strong>
              <p>{error}</p>
            </div>
          ) : null}

          <div ref={endRef} />
        </div>
      </div>

      <footer className="composer-shell">
        <div className="composer-interactions">
          <InteractionPanel
            interactions={interactions}
            locale={locale}
            busyRequestId={busyInteractionId}
            error={interactionError}
            onResolve={onResolveInteraction}
          />
        </div>
        <div className="composer">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('task.composerPlaceholder')}
            aria-label={t('task.composerPlaceholder')}
            rows={1}
            maxLength={64_000}
            disabled={task.status === 'archived' || stopping}
          />
          <button
            type="button"
            className="send-button"
            aria-label={sending ? t('task.sending') : t('task.send')}
            title={sending ? t('task.sending') : t('task.send')}
            disabled={!draft.trim() || sending || task.status === 'archived' || stopping}
            onClick={() => void submit()}
          >
            {sending ? <span className="spinner spinner--small" aria-hidden /> : <SendIcon size={17} />}
          </button>
        </div>
        <p className="composer-hint">{task.workspace}</p>
      </footer>
    </section>
  );
}
