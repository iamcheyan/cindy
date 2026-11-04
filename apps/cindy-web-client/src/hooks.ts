import { useEffect, useState } from 'react';
import { resolveLocale, type Locale } from './i18n';

export type Route = { view: 'tasks' } | { view: 'new' } | { view: 'task'; taskId: string };

function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  if (raw === 'new') return { view: 'new' };
  if (raw.startsWith('task/')) {
    try {
      const id = decodeURIComponent(raw.slice('task/'.length));
      if (id) return { view: 'task', taskId: id };
    } catch {
      // Malformed hash falls back to the task list instead of crashing the app.
    }
  }
  return { view: 'tasks' };
}

export function navigate(route: Route): void {
  const hash =
    route.view === 'new'
      ? '#/new'
      : route.view === 'task'
        ? `#/task/${encodeURIComponent(route.taskId)}`
        : '#/';
  if (window.location.hash !== hash) window.location.hash = hash;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

export type ThemePreference = 'system' | 'light' | 'dark';

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A blocked storage context must not break theme or language selection.
  }
}

function readTheme(): ThemePreference {
  const stored = readStored('cindy.web.theme');
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

export function useTheme(): {
  preference: ThemePreference;
  resolved: 'light' | 'dark';
  setPreference: (value: ThemePreference) => void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(readTheme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const setPreference = (value: ThemePreference) => {
    setPreferenceState(value);
    store('cindy.web.theme', value);
  };

  return { preference, resolved, setPreference };
}

export function useLocale(): { locale: Locale; setLocale: (locale: Locale) => void } {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const stored = readStored('cindy.web.locale');
    return stored ? resolveLocale(stored) : resolveLocale(navigator.language);
  });

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = (value: Locale) => {
    setLocaleState(value);
    store('cindy.web.locale', value);
  };

  return { locale, setLocale };
}

export function useCopy(): { copied: boolean; copy: (value: string) => Promise<void> } {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return { copied, copy };
}
