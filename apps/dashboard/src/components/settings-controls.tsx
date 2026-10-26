'use client';

import { useId, useOptimistic, useState, useTransition, type ReactNode } from 'react';
import {
  setPermissionMode,
  setProjectToggle,
  setTheme,
  updateSettings,
  type ActionResult,
} from '../app/actions';
import { permissionLabel } from '../lib/format';
import { SELECTABLE_PERMISSION_MODES } from '../lib/schemas';
import type { Theme } from '../lib/theme';
import { FolderPath, KindChip } from './project-kind';

/** Runs an action, keeps its message; the server re-renders the page with the saved value. */
export function useAction() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      setResult(await fn());
    });
  const message = result && (
    <span className={`small ${result.ok ? 'ok' : 'error'}`} role={result.ok ? 'status' : 'alert'}>
      {result.ok ? (result.message ?? '') : result.error}
    </span>
  );
  return { pending, run, message };
}

export function Switch({
  label,
  hint,
  checked,
  disabled,
  onChange,
  testId,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  testId?: string;
}) {
  return (
    <label className="switch-row">
      <span className="grow">
        <span>{label}</span>
        {hint && <span className="muted small block">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
        aria-label={label}
      />
    </label>
  );
}

const THEMES = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
] as const;
type ThemeOption = (typeof THEMES)[number][0];

/** Sets <html data-theme> now, ahead of the server render that sets the same value. */
function applyTheme(option: ThemeOption) {
  const root = document.documentElement;
  if (option === 'system') delete root.dataset.theme;
  else root.dataset.theme = option;
}

/** System, Light or Dark for this browser. */
export function ThemeSwitch({ theme }: { theme: Theme | null }) {
  const [, start] = useTransition();
  const saved = theme ?? 'system';
  const [shown, setShown] = useOptimistic<ThemeOption>(saved);
  const hintId = useId();
  const choose = (option: ThemeOption) =>
    start(async () => {
      setShown(option);
      applyTheme(option);
      // Not rethrown: a failed theme save should not take the page down; the switch shows the saved one.
      await setTheme(option).catch(() => applyTheme(saved));
    });
  return (
    <fieldset className="theme-field" aria-describedby={hintId} data-testid="theme-switch">
      <legend>Appearance</legend>
      <div className="segmented">
        {THEMES.map(([option, label]) => (
          <label key={option}>
            <input
              type="radio"
              name="theme"
              value={option}
              className="sr-only"
              checked={shown === option}
              onChange={() => choose(option)}
              data-testid={`theme-${option}`}
            />
            {label}
          </label>
        ))}
      </div>
      <span id={hintId} className="muted small">
        Saved in this browser only.
      </span>
    </fieldset>
  );
}

export function ProjectSettings({
  project,
  readOnly,
}: {
  project: {
    id: number;
    name: string;
    kind: string;
    folderPath: string | null;
    autoMerge: boolean;
    markedForDirectInput: boolean;
    permissionMode: string;
  };
  readOnly: boolean;
}) {
  const { pending, run, message } = useAction();
  // Optimistic: show the new value at once; the refreshed page confirms or reverts it.
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const value = (field: 'autoMerge' | 'markedForDirectInput') => optimistic[field] ?? project[field];
  const toggle = (field: 'autoMerge' | 'markedForDirectInput', next: boolean) => {
    setOptimistic((o) => ({ ...o, [field]: next }));
    run(async () => {
      const result = await setProjectToggle(project.id, field, next);
      setOptimistic((o) => {
        const rest = { ...o };
        delete rest[field];
        return rest;
      });
      return result;
    });
  };
  const modes: readonly string[] = SELECTABLE_PERMISSION_MODES;
  return (
    <div className="card settings-card" data-testid="project-settings" data-project={project.name}>
      <h3>{project.name}</h3>
      {project.kind === 'folder' && (
        <div className="kind-block">
          <KindChip project={project} />
          <FolderPath project={project} />
        </div>
      )}
      {project.kind === 'folder' ? (
        // A folder project has no PRs, so there is nothing to merge: not a control.
        <div className="fixed-row" data-testid="autoMerge-na">
          <span className="grow">
            <span>Auto-merge</span>
            <span className="muted small block">The agent edits the folder in place.</span>
          </span>
          <span className="muted small">n/a (no PRs)</span>
        </div>
      ) : (
        <Switch
          label="Auto-merge"
          hint="Merge when review, tests and QA pass, without waiting for you."
          checked={value('autoMerge')}
          disabled={readOnly || pending}
          onChange={(v) => toggle('autoMerge', v)}
          testId="toggle-autoMerge"
        />
      )}
      <Switch
        label="Marked for direct input"
        hint="New tasks can be routed here."
        checked={value('markedForDirectInput')}
        disabled={readOnly || pending}
        onChange={(v) => toggle('markedForDirectInput', v)}
        testId="toggle-markedForDirectInput"
      />
      <label className="field">
        <span>Agent permission mode</span>
        <select
          value={project.permissionMode}
          disabled={readOnly || pending}
          data-testid="permission-mode"
          onChange={(e) => run(() => setPermissionMode(project.id, e.target.value))}
        >
          {/* A mode set locally (bypassPermissions) shows as the current value but cannot be picked. */}
          {!modes.includes(project.permissionMode) && (
            <option value={project.permissionMode} disabled>
              {permissionLabel(project.permissionMode)} (set locally)
            </option>
          )}
          {modes.map((m) => (
            <option key={m} value={m}>
              {permissionLabel(m)}
            </option>
          ))}
        </select>
      </label>
      {message}
    </div>
  );
}

/**
 * Which agent CLIs the loop may use. Both on: Claude Code, falling back to OpenCode on a usage limit.
 * One on: only that one. The last one on cannot be switched off.
 */
export function ProviderSwitches({
  claude,
  opencode,
  readOnly,
}: {
  claude: boolean;
  opencode: boolean;
  readOnly: boolean;
}) {
  const { pending, run, message } = useAction();
  const [optimistic, setOptimistic] = useState<{ claude?: boolean; opencode?: boolean }>({});
  const on = { claude: optimistic.claude ?? claude, opencode: optimistic.opencode ?? opencode };
  const flip = (which: 'claude' | 'opencode', value: boolean) => {
    setOptimistic((o) => ({ ...o, [which]: value }));
    run(async () => {
      const result = await updateSettings(
        which === 'claude' ? { claudeEnabled: value } : { opencodeEnabled: value },
      );
      setOptimistic({});
      return result;
    });
  };
  return (
    <div className="field" data-testid="provider-switches">
      <span>Agents</span>
      <Switch
        label="Claude Code"
        hint={
          on.opencode
            ? 'Runs sessions; OpenCode takes over on a usage limit.'
            : 'The only agent: sessions wait out a usage limit.'
        }
        checked={on.claude}
        disabled={readOnly || pending || (on.claude && !on.opencode)}
        onChange={(v) => flip('claude', v)}
        testId="toggle-claude"
      />
      <Switch
        label="OpenCode"
        hint={
          on.claude
            ? 'Fallback when Claude usage runs out.'
            : 'The only agent: every session runs on the fallback model.'
        }
        checked={on.opencode}
        disabled={readOnly || pending || (on.opencode && !on.claude)}
        onChange={(v) => flip('opencode', v)}
        testId="toggle-opencode"
      />
      {message}
    </div>
  );
}

export function ModelField({
  field,
  label,
  hint,
  value,
  readOnly,
}: {
  field: 'sessionModel' | 'fallbackModel';
  label: string;
  hint: string;
  value: string;
  readOnly: boolean;
}) {
  const { pending, run, message } = useAction();
  const [text, setText] = useState(value);
  return (
    <form
      className="field"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => updateSettings({ [field]: text }));
      }}
    >
      <span>{label}</span>
      <span className="muted small">{hint}</span>
      <span className="inline-form">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={200}
          disabled={readOnly}
          data-testid={`input-${field}`}
          aria-label={label}
        />
        <button
          type="submit"
          className="secondary"
          disabled={readOnly || pending || text.trim() === '' || text === value}
        >
          Save
        </button>
      </span>
      {message}
    </form>
  );
}

/** OpenCode models to move to, in order, when the current one hits a limit, errors or hangs. */
export function BackupModels({ models, readOnly }: { models: string[]; readOnly: boolean }) {
  const { pending, run, message } = useAction();
  const initial = models.join('\n');
  const [text, setText] = useState(initial);
  const list = text
    .split('\n')
    .map((m) => m.trim())
    .filter(Boolean);
  return (
    <form
      className="field"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => updateSettings({ opencodeBackupModels: list }));
      }}
    >
      <span>Backup OpenCode models</span>
      <span className="muted small">
        One per line, in order. An OpenCode session moves to the next one when its model hits a limit, errors
        or hangs (then back to the fallback model).
      </span>
      <textarea
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={readOnly}
        className="mono"
        aria-label="Backup OpenCode models"
        data-testid="input-backup-models"
      />
      <span className="inline-form">
        <button type="submit" className="secondary" disabled={readOnly || pending || text === initial}>
          Save
        </button>
      </span>
      {message}
    </form>
  );
}
