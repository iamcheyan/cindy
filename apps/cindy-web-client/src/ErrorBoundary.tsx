import { Component, type ReactNode } from 'react';
import { resolveLocale, translate } from './i18n';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
}

export class AppErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const locale = resolveLocale(typeof navigator === 'undefined' ? 'en' : navigator.language);
    return (
      <main className="pairing-shell">
        <section className="pairing-card" role="alert">
          <h1>{translate(locale, 'error.generic')}</h1>
          <button type="button" className="primary-button" onClick={() => window.location.reload()}>
            {translate(locale, 'common.retry')}
          </button>
        </section>
      </main>
    );
  }
}
