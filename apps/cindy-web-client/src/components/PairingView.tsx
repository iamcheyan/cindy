import { useEffect, useRef, useState } from 'react';
import type { PairingRequest, SessionResponse } from '../contract';
import type { WebTransport } from '../api';
import { ApiError } from '../api';
import { translate, type Locale } from '../i18n';
import { SparkIcon } from '../icons';

interface PairingViewProps {
  transport: WebTransport;
  locale: Locale;
  onApproved: (session: SessionResponse) => void;
}

type PairingState =
  | { kind: 'form' }
  | { kind: 'waiting'; request: PairingRequest }
  | { kind: 'expired' }
  | { kind: 'error'; message: string };

export function PairingView({ transport, locale, onApproved }: PairingViewProps) {
  const [label, setLabel] = useState('');
  const [state, setState] = useState<PairingState>({ kind: 'form' });
  const [submitting, setSubmitting] = useState(false);
  const pollAbort = useRef<AbortController | null>(null);
  const failuresRef = useRef(0);
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
    translate(locale, key, params);

  useEffect(() => {
    if (state.kind !== 'waiting') return;
    let cancelled = false;
    const controller = new AbortController();
    pollAbort.current = controller;

    const poll = async () => {
      try {
        const result = await transport.pollPairing(state.request.requestId, controller.signal);
        if (cancelled) return;
        failuresRef.current = 0;
        if (result.status === 'approved') {
          const session = await transport.getSession();
          if (!cancelled) onApproved(session);
        } else if (result.status === 'expired' || result.status === 'revoked') {
          setState({ kind: 'expired' });
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 410) {
          setState({ kind: 'expired' });
          return;
        }
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          setState({ kind: 'error', message: t('error.unauthorized') });
          return;
        }
        if (error instanceof ApiError && error.status === 429) {
          setState({ kind: 'error', message: t('error.rateLimited') });
          return;
        }
        failuresRef.current += 1;
        if (failuresRef.current >= 5) {
          setState({ kind: 'error', message: t('error.network') });
        }
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
      pollAbort.current = null;
    };
  }, [state, transport, locale]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = label.trim();
    if (!name) return;
    setSubmitting(true);
    try {
      const request = await transport.requestPairing(name);
      setState({ kind: 'waiting', request });
    } catch (error) {
      setState({
        kind: 'error',
        message:
          error instanceof ApiError && error.status === 429
            ? t('error.rateLimited')
            : t('pairing.failed'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    pollAbort.current?.abort();
    failuresRef.current = 0;
    setState({ kind: 'form' });
  };

  return (
    <main className="pairing-shell">
      <section className="pairing-card" aria-labelledby="pairing-title">
        <div className="pairing-mark" aria-hidden>
          <SparkIcon size={22} />
        </div>
        <h1 id="pairing-title">{t('pairing.title')}</h1>
        <p className="muted">{t('pairing.description')}</p>

        {state.kind === 'form' ? (
          <form className="pairing-form" onSubmit={submit}>
            <label className="field">
              <span>{t('pairing.label')}</span>
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t('pairing.labelPlaceholder')}
                maxLength={80}
                autoComplete="off"
                autoFocus
                required
              />
            </label>
            <button type="submit" className="primary-button" disabled={submitting || !label.trim()}>
              {submitting ? t('common.loading') : t('pairing.submit')}
            </button>
          </form>
        ) : null}

        {state.kind === 'waiting' ? (
          <div className="pairing-waiting" aria-live="polite">
            <div className="waiting-row">
              <span className="spinner" aria-hidden />
              <strong>{t('pairing.waiting')}</strong>
            </div>
            <p className="muted">
              {t('pairing.label')}: <strong>{label.trim()}</strong>
            </p>
            <p className="muted">{t('pairing.waitingDetailBrowser')}</p>
          </div>
        ) : null}

        {state.kind === 'expired' ? (
          <div className="pairing-waiting">
            <p>{t('pairing.expired')}</p>
            <button type="button" className="primary-button" onClick={reset}>
              {t('pairing.retry')}
            </button>
          </div>
        ) : null}

        {state.kind === 'error' ? (
          <div className="inline-error" role="alert">
            <p>{state.message}</p>
            <button type="button" className="secondary-button" onClick={reset}>
              {t('common.retry')}
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
