import { useEffect, useState } from 'react';
import type { AgentCapability, CreateTaskInput, ServerCapabilities } from '../contract';
import { translate, type Locale } from '../i18n';
import { SparkIcon } from '../icons';
import { readNewTaskDraft, writeNewTaskDraft } from '../drafts';

interface NewTaskViewProps {
  capabilities: ServerCapabilities;
  locale: Locale;
  creating: boolean;
  error: string | null;
  onCreate: (input: CreateTaskInput) => void;
  onCancel: () => void;
}

export function NewTaskView({ capabilities, locale, creating, error, onCreate, onCancel }: NewTaskViewProps) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const firstAgent: AgentCapability | undefined = capabilities.agents[0];
  const saved = readNewTaskDraft();
  const initialAgent = capabilities.agents.find((item) => item.id === saved.agentId) ?? firstAgent;
  const initialModel = initialAgent?.models.includes(saved.model ?? '') ? saved.model! : (initialAgent?.models[0] ?? '');
  const initialEffort = initialAgent?.efforts.includes(saved.effort ?? '') ? saved.effort! : '';
  const initialPermission = initialAgent?.permissionModes.includes(saved.permission ?? '')
    ? saved.permission!
    : (initialAgent?.permissionModes[0] ?? '');
  const [title, setTitle] = useState(() => saved.title ?? '');
  const [workspace, setWorkspace] = useState(() => saved.workspace ?? '');
  const [agentId, setAgentId] = useState(initialAgent?.id ?? '');
  const [model, setModel] = useState(initialModel);
  const [effort, setEffort] = useState(initialEffort);
  const [permission, setPermission] = useState(initialPermission);

  useEffect(() => {
    writeNewTaskDraft({ title, workspace, agentId, model, effort, permission });
  }, [title, workspace, agentId, model, effort, permission]);

  const agent = capabilities.agents.find((item) => item.id === agentId) ?? firstAgent;

  const selectAgent = (id: string) => {
    const next = capabilities.agents.find((item) => item.id === id);
    setAgentId(id);
    setModel(next?.models[0] ?? '');
    setEffort('');
    setPermission(next?.permissionModes[0] ?? '');
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!agent) return;
    onCreate({
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(workspace.trim() ? { workspace: workspace.trim() } : {}),
      agentKind: agent.id,
      model: model || agent.models[0],
      ...(effort ? { effort } : {}),
      ...(permission ? { permissionMode: permission } : {}),
    });
  };

  return (
    <section className="new-task-view" aria-labelledby="new-task-title">
      <div className="new-task-card">
        <div className="new-task-mark" aria-hidden>
          <SparkIcon size={20} />
        </div>
        <h1 id="new-task-title">{t('new.title')}</h1>
        <p className="muted">{t('new.description')}</p>

        {!agent ? (
          <div className="inline-error" role="alert">
            <p>{t('error.generic')}</p>
            <button type="button" className="secondary-button" onClick={onCancel}>
              {t('new.cancel')}
            </button>
          </div>
        ) : (
          <form className="new-task-form" onSubmit={submit}>
            <label className="field">
              <span>{t('new.titleLabel')}</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t('new.titlePlaceholder')}
                maxLength={200}
              />
            </label>

            <label className="field">
              <span>{t('new.workspaceLabel')}</span>
              <input
                value={workspace}
                onChange={(event) => setWorkspace(event.target.value)}
                placeholder={capabilities.defaultWorkspace || t('new.default')}
                spellCheck={false}
              />
              <small>{t('new.workspaceHint')}</small>
            </label>

            <div className="form-grid">
              <label className="field">
                <span>{t('new.agentLabel')}</span>
                <select value={agent.id} onChange={(event) => selectAgent(event.target.value)}>
                  {capabilities.agents.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label || item.id}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>{t('new.modelLabel')}</span>
                <select value={model} onChange={(event) => setModel(event.target.value)}>
                  {agent.models.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>{t('new.effortLabel')}</span>
                <select value={effort} onChange={(event) => setEffort(event.target.value)}>
                  <option value="">{t('new.default')}</option>
                  {agent.efforts.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>{t('new.permissionLabel')}</span>
                <select value={permission} onChange={(event) => setPermission(event.target.value)}>
                  {agent.permissionModes.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {error ? (
              <div className="inline-error" role="alert">
                <p>{error}</p>
              </div>
            ) : null}

            <div className="form-actions">
              <button type="button" className="secondary-button" onClick={onCancel} disabled={creating}>
                {t('new.cancel')}
              </button>
              <button type="submit" className="primary-button" disabled={creating}>
                {creating ? t('new.creating') : t('new.create')}
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
