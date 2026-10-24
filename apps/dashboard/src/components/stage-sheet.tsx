'use client';

import { useState } from 'react';
import type { Stage } from '../lib/schemas';
import { Icon, STAGE_ICONS } from './pipeline';

export type StageFields = Pick<Stage, 'title' | 'label' | 'icon' | 'access' | 'runs' | 'prompt'>;
/** A stage's file fields only, as the server writes them. */
const fieldsOf = ({ title, label, icon, access, runs, prompt }: StageFields): StageFields => ({
  title,
  label,
  icon,
  access,
  runs,
  prompt,
});

const ACCESS = [
  ['read', 'Read files only'],
  ['shell', 'Run commands'],
  ['browser', 'Run commands and a browser'],
] as const;
const RUNS = [
  ['always', 'On every PR'],
  ['ui-changes', 'Only when UI files change'],
] as const;

/** A stage id from its title: "Security review" → "security-review". */
const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'stage';

/** A stage's settings and prompt; for a new stage also its id, from the title. */
export function StageSheet({
  stage,
  isNew,
  inPipeline,
  taken,
  onSave,
  onReset,
  onClose,
}: {
  stage: Stage;
  isNew: boolean;
  inPipeline: boolean;
  /** A stage with this id exists already. */
  taken: (id: string) => boolean;
  onSave: (id: string, fields: StageFields) => void;
  onReset: (id: string) => void;
  onClose: () => void;
}) {
  const [f, setF] = useState<StageFields>(fieldsOf(stage));
  const set = (patch: Partial<StageFields>) => setF((prev) => ({ ...prev, ...patch }));
  const id = isNew ? slug(f.title) : stage.id;
  const clash = isNew && taken(id);
  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={isNew ? 'New stage' : stage.title}
    >
      <form
        className="editor-sheet stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(id, f);
        }}
      >
        <h2>{isNew ? 'New stage' : stage.title}</h2>
        <label className="field">
          Name
          <input value={f.title} maxLength={60} required onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="field">
          Label on the node (10 characters at most)
          <input value={f.label} maxLength={10} required onChange={(e) => set({ label: e.target.value })} />
        </label>
        <fieldset className="icon-picker">
          <legend>Icon</legend>
          {STAGE_ICONS.map((icon) => (
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
        {stage.builtin ? (
          <p className="muted small">A built-in stage: what it may do and when it runs are fixed.</p>
        ) : (
          <>
            <label className="field">
              It may
              <select value={f.access} onChange={(e) => set({ access: e.target.value })}>
                {ACCESS.map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Runs
              <select value={f.runs} onChange={(e) => set({ runs: e.target.value })}>
                {RUNS.map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="field">
          What to check
          <textarea
            value={f.prompt}
            rows={8}
            maxLength={4000}
            required
            onChange={(e) => set({ prompt: e.target.value })}
            data-testid="stage-prompt"
          />
        </label>
        <p className="muted small">
          The loop adds the PR, the request and the diff, and asks for pass or fail. Failures go back to the
          builder. No stage can edit files or push.
        </p>
        <div className="row-actions">
          <button type="submit" disabled={clash} data-testid="stage-save">
            {isNew ? 'Add stage' : 'Done'}
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          {!isNew && (stage.builtin ? stage.overridden : !inPipeline) && (
            <button type="button" className="ghost danger" onClick={() => onReset(stage.id)}>
              {stage.builtin ? 'Reset to built-in' : 'Delete stage'}
            </button>
          )}
        </div>
        {isNew && (
          <p className={`small mono ${clash ? 'error' : 'muted'}`}>
            {clash ? `A stage named ${id} exists already.` : `Saved as data/stages/${id}.md`}
          </p>
        )}
      </form>
    </div>
  );
}
