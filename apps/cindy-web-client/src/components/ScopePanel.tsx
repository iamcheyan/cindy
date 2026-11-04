import { useEffect, useRef } from 'react';
import { translate, type Locale } from '../i18n';
import { CloseIcon } from '../icons';

interface ScopePanelProps {
  locale: Locale;
  onClose: () => void;
}

export function ScopePanel({ locale, onClose }: ScopePanelProps) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="scope-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="scope-dialog" role="dialog" aria-modal="true" aria-labelledby="scope-title">
        <header className="scope-header">
          <h2 id="scope-title">{t('scope.title')}</h2>
          <button ref={closeRef} type="button" className="icon-button" aria-label={t('scope.close')} title={t('scope.close')} onClick={onClose}>
            <CloseIcon size={18} />
          </button>
        </header>
        <p className="muted">{t('scope.intro')}</p>
        <div className="scope-section">
          <h3>{t('scope.availableTitle')}</h3>
          <p>{t('scope.availableText')}</p>
        </div>
        <div className="scope-section scope-section--muted">
          <h3>{t('scope.unavailableTitle')}</h3>
          <p>{t('scope.unavailableText')}</p>
        </div>
        <footer className="scope-footer">
          <button type="button" className="primary-button" onClick={onClose}>{t('scope.close')}</button>
        </footer>
      </section>
    </div>
  );
}
