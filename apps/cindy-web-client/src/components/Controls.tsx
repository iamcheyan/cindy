import { LOCALES, translate, type Locale, type MessageKey } from '../i18n';
import type { ThemePreference } from '../hooks';
import { MonitorIcon, MoonIcon, SunIcon } from '../icons';

interface ControlsProps {
  locale: Locale;
  onLocale: (locale: Locale) => void;
  theme: ThemePreference;
  onTheme: (theme: ThemePreference) => void;
  compact?: boolean;
}

const THEME_OPTIONS: Array<{
  value: ThemePreference;
  labelKey: MessageKey;
  icon: typeof SunIcon;
}> = [
  { value: 'light', labelKey: 'nav.theme', icon: SunIcon },
  { value: 'dark', labelKey: 'nav.theme', icon: MoonIcon },
  { value: 'system', labelKey: 'nav.theme', icon: MonitorIcon },
];

export function LocaleSelect({ locale, onLocale, compact }: Omit<ControlsProps, 'theme' | 'onTheme'>) {
  return (
    <label className={`control-select ${compact ? 'control-select--compact' : ''}`}>
      <span className="sr-only">{translate(locale, 'a11y.language')}</span>
      <select
        aria-label={translate(locale, 'a11y.language')}
        value={locale}
        onChange={(event) => onLocale(event.target.value as Locale)}
      >
        {LOCALES.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ThemeControl({ locale, theme, onTheme }: Omit<ControlsProps, 'onLocale' | 'compact'>) {
  return (
    <div className="theme-control" role="group" aria-label={translate(locale, 'a11y.theme')}>
      {THEME_OPTIONS.map(({ value, icon: Icon }) => (
        <button
          key={value}
          type="button"
          className="icon-button"
          aria-label={`${translate(locale, 'nav.theme')}: ${value}`}
          aria-pressed={theme === value}
          title={`${translate(locale, 'nav.theme')}: ${value}`}
          onClick={() => onTheme(value)}
        >
          <Icon size={16} />
        </button>
      ))}
    </div>
  );
}
