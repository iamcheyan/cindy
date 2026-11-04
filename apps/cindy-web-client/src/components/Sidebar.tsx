import type { SessionResponse, Task } from '../contract';
import type { Locale } from '../i18n';
import { translate } from '../i18n';
import type { ThemePreference } from '../hooks';
import { useCopy } from '../hooks';
import {
  ArchiveIcon,
  CloseIcon,
  CopyIcon,
  InfoIcon,
  LogoutIcon,
  PlusIcon,
  RefreshIcon,
  SparkIcon,
} from '../icons';
import { LocaleSelect, ThemeControl } from './Controls';

type TaskFilter = 'active' | 'archived' | 'all';

interface SidebarProps {
  session: SessionResponse;
  tasks: Task[];
  selectedTaskId: string | null;
  filter: TaskFilter;
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  open: boolean;
  locale: Locale;
  theme: ThemePreference;
  onFilter: (filter: TaskFilter) => void;
  onSelect: (task: Task) => void;
  onNew: () => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  onScope: () => void;
  onLogout: () => void;
  onClose: () => void;
  onLocale: (locale: Locale) => void;
  onTheme: (theme: ThemePreference) => void;
}

function relativeTime(locale: Locale, timestamp: number): string {
  const delta = timestamp - Date.now();
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const minutes = Math.round(delta / 60_000);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

function exposureLabel(locale: Locale, status: SessionResponse['server']['exposure']['status']): string {
  switch (status) {
    case 'ready':
      return translate(locale, 'server.exposure.ready');
    case 'loopback-only':
      return translate(locale, 'server.exposure.loopback-only');
    case 'disabled':
      return translate(locale, 'server.exposure.disabled');
    case 'verifying':
      return translate(locale, 'server.exposure.verifying');
    case 'unavailable':
      return translate(locale, 'server.exposure.unavailable');
    default:
      return translate(locale, 'server.exposure.error');
  }
}

export function Sidebar({
  session,
  tasks,
  selectedTaskId,
  filter,
  loading,
  hasMore,
  loadingMore,
  open,
  locale,
  theme,
  onFilter,
  onSelect,
  onNew,
  onRefresh,
  onLoadMore,
  onScope,
  onLogout,
  onClose,
  onLocale,
  onTheme,
}: SidebarProps) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const { copied, copy } = useCopy();
  const exposure = session.server.exposure;
  const readyUrl = exposure.status === 'ready' ? exposure.url : undefined;

  return (
    <>
      {open ? <button type="button" className="sidebar-backdrop" aria-label={t('a11y.closeSidebar')} onClick={onClose} /> : null}
      <aside className={`sidebar ${open ? 'sidebar--open' : ''}`} aria-label={t('a11y.taskList')}>
        <header className="sidebar-header">
          <div className="brand">
            <span className="brand-mark" aria-hidden>
              <SparkIcon size={16} />
            </span>
            <span className="brand-name">Cindy</span>
          </div>
          <button
            type="button"
            className="icon-button sidebar-close"
            aria-label={t('a11y.closeSidebar')}
            title={t('a11y.closeSidebar')}
            onClick={onClose}
          >
            <CloseIcon size={18} />
          </button>
        </header>

        <div className={`exposure exposure--${exposure.status}`}>
          <div className="exposure-line">
            <span className="status-dot" aria-hidden />
            <span className="exposure-label">{exposureLabel(locale, exposure.status)}</span>
          </div>
          {readyUrl ? (
            <div className="exposure-url">
              <span title={readyUrl}>{readyUrl}</span>
              <button
                type="button"
                className="icon-button icon-button--small"
                aria-label={t('server.copy')}
                title={t('server.copy')}
                onClick={() => void copy(readyUrl)}
              >
                <CopyIcon size={14} />
              </button>
            </div>
          ) : null}
          {copied ? <span className="copy-note">{t('server.copied')}</span> : null}
          {!readyUrl && exposure.detail ? <p className="exposure-detail">{exposure.detail}</p> : null}
        </div>

        <button type="button" className="primary-button new-task-button" onClick={onNew}>
          <PlusIcon size={16} />
          {t('nav.newTask')}
        </button>

        <div className="filter-row" role="group" aria-label={t('nav.tasks')}>
          {(['active', 'archived', 'all'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className="filter-chip"
              aria-pressed={filter === value}
              onClick={() => onFilter(value)}
            >
              {value === 'active' ? t('filter.active') : value === 'archived' ? t('filter.archived') : t('filter.all')}
            </button>
          ))}
        </div>

        <nav className="task-list" aria-label={t('a11y.taskList')}>
          {loading && tasks.length === 0 ? (
            <p className="sidebar-note">{t('tasks.loading')}</p>
          ) : null}
          {!loading && tasks.length === 0 ? (
            <div className="sidebar-empty">
              <p>{t('tasks.empty')}</p>
              <p className="muted">{t('tasks.emptyHint')}</p>
            </div>
          ) : null}
          {tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              className={`task-item ${task.id === selectedTaskId ? 'task-item--selected' : ''} ${task.status === 'archived' ? 'task-item--archived' : ''}`}
              aria-current={task.id === selectedTaskId ? 'page' : undefined}
              onClick={() => onSelect(task)}
            >
              <span className="task-item-title">{task.title || t('tasks.untitled')}</span>
              <span className="task-item-meta">
                <span className="task-agent">{task.agentKind}</span>
                <span aria-hidden>·</span>
                <span>{relativeTime(locale, task.updatedAt)}</span>
                {task.status === 'archived' ? <ArchiveIcon size={13} /> : null}
              </span>
            </button>
          ))}
          {hasMore ? (
            <button type="button" className="load-more-button" onClick={onLoadMore} disabled={loadingMore}>
              {loadingMore ? t('common.loading') : t('tasks.loadMore')}
            </button>
          ) : null}
        </nav>

        <footer className="sidebar-footer">
          <div className="footer-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={t('nav.refresh')}
              title={t('nav.refresh')}
              onClick={onRefresh}
            >
              <RefreshIcon size={16} />
            </button>
            <LocaleSelect locale={locale} onLocale={onLocale} compact />
            <button
              type="button"
              className="icon-button"
              aria-label={t('scope.open')}
              title={t('scope.open')}
              onClick={onScope}
            >
              <InfoIcon size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t('nav.logout')}
              title={t('nav.logout')}
              onClick={onLogout}
            >
              <LogoutIcon size={16} />
            </button>
          </div>
          <ThemeControl locale={locale} theme={theme} onTheme={onTheme} />
          <p className="client-label">
            {session.client.label}
            <span className="client-id">{session.client.id.slice(0, 8)}</span>
          </p>
        </footer>
      </aside>
    </>
  );
}

export type { TaskFilter };
