'use client';

import { useOptimistic, useState, useTransition } from 'react';
import { setAgentModel } from '../app/actions';
import { isModelName, MODEL_NAME_MAX, type ModelSource } from '../lib/schemas';
import { shortModel, type AgentModelView } from '../lib/models';
import { Dialog } from './dialog';

const SOURCE_WORDS: Record<ModelSource | 'default', string> = {
  planner: 'chosen by the Planner',
  human: 'set by you',
  default: 'the default',
};

/**
 * The model name on top of an agent's node: a small caption, and for a Claude agent a button that
 * opens the model menu (the session's allowed models, a free-text name, "Use the default"). A choice
 * shows at once, is saved as the human's (the Planner no longer changes it) and applies from the
 * agent's next job (the builder: its next resume). Plain text in demo mode and in the editor.
 */
export function ModelTag({
  sessionId,
  agent,
  label,
  view,
  allowed,
  locked,
}: {
  sessionId: number;
  /** "builder" or a check's stage id. */
  agent: string;
  /** The node's name, for the accessible name and the menu's title. */
  label: string;
  view: AgentModelView;
  allowed: string[];
  /** Demo mode or the editor's preview: shown, never changed. */
  locked: boolean;
}) {
  const [shown, show] = useOptimistic(view);
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const title = `${shown.model} (${SOURCE_WORDS[shown.by]})`;
  const caption = (
    <span className="node-model-name" data-testid="node-model-name">
      {shortModel(shown.model)}
    </span>
  );
  if (locked || !view.editable) {
    return (
      <span className="node-model" data-source={shown.by} title={title} data-testid="node-model">
        {caption}
      </span>
    );
  }

  const choose = (model: string | null) => {
    const name = model?.trim() ?? null;
    if (name !== null && !isModelName(name)) {
      setError(
        `Use letters, digits and . - _ / : only, not starting with a dash (${MODEL_NAME_MAX} at most)`,
      );
      return;
    }
    setError(null);
    setOpen(false);
    start(async () => {
      show(
        name === null
          ? { ...view, model: view.fallback, by: 'default' }
          : { ...view, model: name, by: 'human' },
      );
      const result = await setAgentModel(sessionId, agent, name).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      }));
      // Part of the transition, so the menu comes back as the caption flips back, not before.
      if (!result.ok)
        start(() => {
          setError(result.error);
          setOpen(true);
        });
    });
  };
  const when = agent === 'builder' ? "the builder's next resume" : `the next ${label} job`;
  return (
    <>
      <span className="node-model" data-source={shown.by} title={title} data-testid="node-model">
        <button
          type="button"
          className="node-model-button"
          aria-label={`Model for ${label}: ${shown.model}. Change`}
          aria-haspopup="dialog"
          onClick={() => {
            setError(null);
            setCustom('');
            setOpen(true);
          }}
          data-testid="node-model-button"
        >
          {caption}
        </button>
      </span>
      {/* The node opens its terminal on a double-click; one inside the menu must not reach it. */}
      {open && (
        <span className="contents" onDoubleClick={(e) => e.stopPropagation()}>
          <Dialog label={`Model for ${label}`} onClose={() => setOpen(false)} testId="model-menu">
            <h2>Model for {label}</h2>
            <p className="muted small">
              Now {shown.model} ({SOURCE_WORDS[shown.by]}). A choice applies from {when} and stays yours: the
              Planner no longer changes it.
            </p>
            <ul
              className="model-choices"
              aria-label="Models"
              onKeyDown={(e) => {
                if (
                  e.key !== 'ArrowDown' &&
                  e.key !== 'ArrowUp' &&
                  e.key !== 'ArrowRight' &&
                  e.key !== 'ArrowLeft'
                )
                  return;
                const items = [...e.currentTarget.querySelectorAll('button')];
                const at = items.indexOf(document.activeElement as HTMLButtonElement);
                const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
                e.preventDefault();
                items[(at + step + items.length) % items.length]?.focus();
              }}
            >
              {allowed.map((name) => (
                <li key={name}>
                  <button
                    type="button"
                    className={name === shown.model && shown.by !== 'default' ? 'primary' : 'secondary'}
                    aria-pressed={name === shown.model && shown.by !== 'default'}
                    onClick={() => choose(name)}
                    data-testid="model-choice"
                  >
                    {name}
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="row-actions"
              onSubmit={(e) => {
                e.preventDefault();
                choose(custom);
              }}
            >
              <input
                type="text"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="Another model name"
                aria-label="Another model name"
                maxLength={MODEL_NAME_MAX}
                autoComplete="off"
                spellCheck={false}
                data-testid="model-custom"
              />
              <button type="submit" disabled={custom.trim() === ''} data-testid="model-custom-use">
                Use
              </button>
            </form>
            {custom.includes('/') && (
              <p className="warning small" data-testid="model-custom-warning">
                A name with a slash looks like an OpenCode model. Claude agents cannot run it: the job or the
                launch would fail.
              </p>
            )}
            {error && (
              <p className="error small" role="alert">
                {error}
              </p>
            )}
            <div className="row-actions">
              <button
                type="button"
                className="secondary"
                disabled={shown.by === 'default'}
                onClick={() => choose(null)}
                data-testid="model-default"
              >
                Use the default ({view.fallback})
              </button>
              <button type="button" className="ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </Dialog>
        </span>
      )}
    </>
  );
}
