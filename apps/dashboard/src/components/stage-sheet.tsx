'use client';

import { useState } from 'react';
import { GUARDIAN_NODE } from '../lib/board';
import type { Stage, StageChoices } from '../lib/schemas';
import { Dialog } from './dialog';
import { Icon } from './pipeline';

export type StageFields = Pick<Stage, 'title' | 'label' | 'icon' | 'access' | 'runs' | 'prompt'>;
/** A stage's file fields only, as the server writes them. */
export const fieldsOf = ({ title, label, icon, access, runs, prompt }: StageFields): StageFields => ({
  title,
  label,
  icon,
  access,
  runs,
  prompt,
});

/** Words for the server's values; a value with no words here is shown as it is. */
const ACCESS_WORDS: Record<string, string> = {
  read: 'Read files only',
  shell: 'Run commands',
  browser: 'Run commands and a browser',
};
const RUNS_WORDS: Record<string, string> = {
  always: 'On every PR',
  'code-changes': 'When code changes (not only docs)',
  'ui-changes': 'Only when UI files change',
  'server-changes': 'Only when server code changes',
  'test-changes': 'Only when tests change',
  'docs-changes': 'Only when docs change',
  'dependency-changes': 'Only when dependencies change',
  'database-changes': 'Only when database files change',
  'infra-changes': 'Only when CI or deploy files change',
};

/** A stage id from its title: "Security review" → "security-review". */
const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

/** A stage's settings and prompt; for a new stage also its id, from the title. */
export function StageSheet({
  stage,
  isNew,
  choices,
  taken,
  onSave,
  onReset,
  onDelete,
  onClose,
}: {
  stage: Stage;
  isNew: boolean;
  choices: StageChoices;
  /** A stage with this id exists already. */
  taken: (id: string) => boolean;
  onSave: (id: string, fields: StageFields) => void;
  onReset: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [f, setF] = useState<StageFields>(fieldsOf(stage));
  // The Guardian's instructions: only the prompt is the user's to change.
  const guardian = stage.id === GUARDIAN_NODE;
  const set = (patch: Partial<StageFields>) => setF((prev) => ({ ...prev, ...patch }));
  const id = isNew ? slug(f.title) : stage.id;
  const problem = !isNew
    ? null
    : !id
      ? 'Use a name with letters or digits.'
      : choices.reserved.includes(id)
        ? `"${id}" is a pipeline node's name; pick another.`
        : taken(id)
          ? `A stage named ${id} exists already.`
          : null;
  return (
    <Dialog label={isNew ? 'New stage' : stage.title} onClose={onClose} testId="stage-sheet">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          // A built-in's prompt left empty means its own again.
          if (stage.builtin && !isNew && !f.prompt.trim()) onReset(stage.id);
          else onSave(id, f);
        }}
      >
        <h2>{isNew ? 'New stage' : stage.title}</h2>
        {stage.error && (
          <p className="warning small">
            {guardian
              ? `Its file is broken (${stage.error}), so the Guardian uses its built-in instructions. Saving here writes a working one.`
              : `Its file is broken (${stage.error}), so PRs wait at it. Saving here writes a working one.`}
          </p>
        )}
        {guardian && (
          <p className="muted small">
            After each deploy and once a day, the Guardian checks the live site: its API, pages, speed and
            integrations. Tell it what matters most in your product.
          </p>
        )}
        {!guardian && (
          <>
            <label className="field">
              Name
              <input
                type="text"
                value={f.title}
                maxLength={60}
                required
                onChange={(e) => set({ title: e.target.value })}
              />
            </label>
            <label className="field">
              Label on the node (10 characters at most)
              <input
                type="text"
                value={f.label}
                maxLength={10}
                required
                onChange={(e) => set({ label: e.target.value })}
              />
            </label>
            <fieldset className="icon-picker">
              <legend>Icon</legend>
              {choices.icons.map((icon) => (
                <label key={icon} className={f.icon === icon ? 'picked' : ''}>
                  <input
                    type="radio"
                    name="icon"
                    className="sr-only"
                    checked={f.icon === icon}
                    onChange={() => set({ icon })}
                  />
                  <Icon kind={icon} />
                  <span className="sr-only">{icon}</span>
                </label>
              ))}
            </fieldset>
          </>
        )}
        {guardian ? null : stage.builtin ? (
          <p className="muted small">A built-in stage: what it may do and when it runs are fixed.</p>
        ) : (
          <>
            <label className="field">
              It may
              <select value={f.access} onChange={(e) => set({ access: e.target.value })}>
                {choices.access.map((value) => (
                  <option key={value} value={value}>
                    {ACCESS_WORDS[value] ?? value}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Runs
              <select value={f.runs} onChange={(e) => set({ runs: e.target.value })}>
                {choices.runs.map((value) => (
                  <option key={value} value={value}>
                    {RUNS_WORDS[value] ?? value}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="field">
          {guardian ? 'Instructions' : 'What to check'}
          <textarea
            value={f.prompt}
            rows={8}
            maxLength={4000}
            required={!stage.builtin}
            placeholder={stage.builtin ? 'The built-in prompt (restored when you Save).' : undefined}
            onChange={(e) => set({ prompt: e.target.value })}
            data-testid="stage-prompt"
          />
        </label>
        {!guardian && (
          <p className="muted small">
            The loop adds the PR, the request and the diff, and asks for pass or fail. Failures go back to the
            builder. No stage can edit files or push.
          </p>
        )}
        {problem && <p className="error small">{problem}</p>}
        {isNew && !problem && <p className="muted small mono">Saved as {id}.md in your stages folder</p>}
        <div className="row-actions">
          <button type="submit" disabled={problem !== null} data-testid="stage-save">
            {isNew ? 'Add stage' : 'Done'}
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          {!isNew && stage.builtin && (stage.overridden || stage.error) && (
            <button type="button" className="ghost" onClick={() => onReset(stage.id)}>
              Reset to built-in
            </button>
          )}
          {!isNew && !stage.builtin && (
            <button
              type="button"
              className="ghost danger"
              onClick={() => onDelete(stage.id)}
              data-testid="stage-delete"
            >
              Delete stage
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
