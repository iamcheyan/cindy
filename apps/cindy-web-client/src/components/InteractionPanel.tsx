import { useMemo, useState } from 'react';
import type {
  AskUserQuestionItem,
  InteractionDecisionInput,
  PendingInteraction,
} from '../contract';
import { translate, type Locale } from '../i18n';

interface InteractionPanelProps {
  interactions: PendingInteraction[];
  locale: Locale;
  busyRequestId: string | null;
  error: string | null;
  onResolve: (requestId: string, decision: InteractionDecisionInput) => void;
}

const KIND_PRIORITY: Record<string, number> = {
  plan_review: 0,
  permission: 1,
  ask_user_question: 2,
};

function displayJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    if (!text) return '';
    return text.length > 6_000 ? `${text.slice(0, 6_000)}\n…` : text;
  } catch {
    return '';
  }
}

function questionKey(question: AskUserQuestionItem): string {
  return question.question;
}

function answerFor(
  question: AskUserQuestionItem,
  selected: string[],
  custom: string,
): string {
  if (question.multiSelect) {
    const values = [...selected];
    if (custom.trim()) values.push(custom.trim());
    return JSON.stringify(values);
  }
  return custom.trim() || selected[0] || '';
}

export function InteractionPanel({
  interactions,
  locale,
  busyRequestId,
  error,
  onResolve,
}: InteractionPanelProps) {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const sorted = useMemo(
    () =>
      [...interactions].sort(
        (left, right) =>
          (KIND_PRIORITY[left.request.kind] ?? 99) - (KIND_PRIORITY[right.request.kind] ?? 99) ||
          (left.createdAt ?? 0) - (right.createdAt ?? 0),
      ),
    [interactions],
  );

  if (sorted.length === 0) return null;

  return (
    <section className="interaction-panel" aria-label={t('interaction.title')}>
      <div className="interaction-panel-head">
        <span className="interaction-panel-title">{t('interaction.title')}</span>
        <span className="interaction-count">{sorted.length}</span>
      </div>
      {error ? (
        <div className="inline-error" role="alert">
          <p>{error}</p>
        </div>
      ) : null}
      <div className="interaction-list">
        {sorted.map((item) => (
          <InteractionCard
            key={item.request.requestId}
            interaction={item}
            locale={locale}
            busy={busyRequestId === item.request.requestId}
            onResolve={onResolve}
          />
        ))}
      </div>
    </section>
  );
}

function InteractionCard({
  interaction,
  locale,
  busy,
  onResolve,
}: {
  interaction: PendingInteraction;
  locale: Locale;
  busy: boolean;
  onResolve: (requestId: string, decision: InteractionDecisionInput) => void;
}) {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const request = interaction.request;
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState('');
  const [planDraft, setPlanDraft] = useState(request.kind === 'plan_review' ? request.plan : '');

  const kindLabel =
    request.kind === 'permission'
      ? t('interaction.permission')
      : request.kind === 'plan_review'
        ? t('interaction.plan')
        : t('interaction.ask');

  const toggleOption = (question: AskUserQuestionItem, label: string) => {
    const key = questionKey(question);
    setSelected((previous) => {
      const current = previous[key] ?? [];
      if (!question.multiSelect) return { ...previous, [key]: [label] };
      const next = current.includes(label) ? current.filter((item) => item !== label) : [...current, label];
      return { ...previous, [key]: next };
    });
  };

  const submitPermission = (behavior: 'allow' | 'deny', scope?: 'once' | 'session') => {
    onResolve(request.requestId, { kind: 'permission', behavior, ...(scope ? { scope } : {}) });
  };

  const submitQuestions = () => {
    if (request.kind !== 'ask_user_question') return;
    const answers: Record<string, string> = {};
    for (const question of request.questions) {
      const key = questionKey(question);
      answers[key] = answerFor(question, selected[key] ?? [], custom[key] ?? '');
    }
    onResolve(request.requestId, { kind: 'ask_user_question', answers });
  };

  const questionsComplete =
    request.kind === 'ask_user_question' &&
    request.questions.every((question) => {
      const key = questionKey(question);
      return (selected[key]?.length ?? 0) > 0 || Boolean(custom[key]?.trim());
    });

  const submitPlan = (behavior: 'allow' | 'deny') => {
    if (request.kind !== 'plan_review') return;
    const editedPlan = planDraft.trim() && planDraft !== request.plan ? planDraft : undefined;
    onResolve(request.requestId, {
      kind: 'plan_review',
      behavior,
      ...(editedPlan ? { editedPlan } : {}),
      ...(behavior === 'deny' && feedback.trim() ? { reason: feedback.trim() } : {}),
    });
  };

  return (
    <article className={`interaction-card interaction-card--${request.kind}`}>
      <header className="interaction-card-head">
        <span className="interaction-kind">{kindLabel}</span>
        <span className="interaction-request-id" title={request.requestId}>
          {request.requestId.slice(0, 8)}
        </span>
      </header>

      {request.kind === 'permission' ? (
        <>
          <h3 className="interaction-heading">
            {request.title || request.displayName || request.toolName}
          </h3>
          {request.description ? <p className="muted">{request.description}</p> : null}
          <div className="interaction-tool">
            <span>{t('interaction.tool')}</span>
            <code>{request.toolName}</code>
          </div>
          {request.input && Object.keys(request.input).length > 0 ? (
            <details className="interaction-details">
              <summary>{t('interaction.input')}</summary>
              <pre>{displayJson(request.input)}</pre>
            </details>
          ) : null}
          <div className="interaction-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => submitPermission('deny')}
            >
              {t('interaction.deny')}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => submitPermission('allow', 'session')}
            >
              {t('interaction.allowSession')}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => submitPermission('allow', 'once')}
            >
              {busy ? t('interaction.submitting') : t('interaction.allowOnce')}
            </button>
          </div>
        </>
      ) : null}

      {request.kind === 'ask_user_question' ? (
        <>
          <div className="interaction-questions">
            {request.questions.map((question, index) => {
              const key = questionKey(question);
              const options = question.options ?? [];
              return (
                <fieldset key={`${key}:${index}`} className="interaction-question">
                  <legend>
                    {question.header ? <span className="question-header">{question.header}</span> : null}
                    {question.question}
                  </legend>
                  {question.multiSelect ? <p className="muted small">{t('interaction.multiSelect')}</p> : null}
                  {options.length > 0 ? (
                    <div className="interaction-options">
                      {options.map((option) => {
                        const checked = (selected[key] ?? []).includes(option.label);
                        return (
                          <label key={option.label} className={`interaction-option ${checked ? 'interaction-option--on' : ''}`}>
                            <input
                              type={question.multiSelect ? 'checkbox' : 'radio'}
                              name={`${request.requestId}:${index}`}
                              checked={checked}
                              onChange={() => toggleOption(question, option.label)}
                            />
                            <span>
                              <strong>{option.label}</strong>
                              {option.description ? <small>{option.description}</small> : null}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}
                  <input
                    className="interaction-answer"
                    value={custom[key] ?? ''}
                    onChange={(event) =>
                      setCustom((previous) => ({ ...previous, [key]: event.target.value }))
                    }
                    placeholder={t('interaction.answerPlaceholder')}
                    aria-label={`${question.question} — ${t('interaction.answerPlaceholder')}`}
                  />
                </fieldset>
              );
            })}
          </div>
          <div className="interaction-actions">
            <button
              type="button"
              className="primary-button"
              disabled={busy || !questionsComplete}
              onClick={submitQuestions}
            >
              {busy ? t('interaction.submitting') : t('interaction.submit')}
            </button>
          </div>
        </>
      ) : null}

      {request.kind === 'plan_review' ? (
        <>
          {request.planFilePath ? (
            <p className="muted small interaction-plan-path">{request.planFilePath}</p>
          ) : null}
          <label className="field interaction-plan-field">
            <span>{t('interaction.planEdit')}</span>
            <textarea
              value={planDraft}
              onChange={(event) => setPlanDraft(event.target.value)}
              rows={Math.min(16, Math.max(6, planDraft.split('\n').length))}
            />
          </label>
          <label className="field">
            <span>{t('interaction.feedback')}</span>
            <input
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder={t('interaction.feedbackPlaceholder')}
            />
          </label>
          <div className="interaction-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => submitPlan('deny')}
            >
              {t('interaction.requestChanges')}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => submitPlan('allow')}
            >
              {busy ? t('interaction.submitting') : t('interaction.approve')}
            </button>
          </div>
        </>
      ) : null}
    </article>
  );
}
