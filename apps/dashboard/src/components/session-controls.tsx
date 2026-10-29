'use client';

import type { TerminalTarget } from '../lib/terminal-tabs';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, useTransition, type ReactNode } from 'react';
import {
  createRequest,
  messageSession,
  openStageTerminal,
  openTerminal,
  type ActionResult,
} from '../app/actions';
import { StartingPipeline, startingAfter, visibleStarting, type Starting } from './starting-pipeline';

/** A text box that sends one message, then clears; used for "+" on a session and on a project. */
export function Composer({
  label,
  placeholder,
  submitLabel,
  send,
  onClose,
  onSent,
  readOnly,
  testId,
  rows = 3,
}: {
  label: string;
  placeholder: string;
  submitLabel: string;
  send: (text: string) => Promise<ActionResult>;
  onClose: () => void;
  /** Called with the text once it was sent successfully. */
  onSent?: (text: string) => void;
  readOnly: boolean;
  testId: string;
  /** Taller for a new session's brief: the prompt tends to be longer than a reply. */
  rows?: number;
}) {
  const [pending, start] = useTransition();
  const [text, setText] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <form
      className="composer"
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault();
        if (readOnly || pending || text.trim() === '') return;
        start(async () => {
          const r = await send(text);
          setResult(r);
          if (r.ok) {
            setText('');
            onSent?.(text);
          }
        });
      }}
    >
      <label className="field">
        <span>{label}</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Cmd+Enter on a Mac, Ctrl+Enter elsewhere.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          rows={rows}
          maxLength={4000}
          placeholder={placeholder}
          disabled={readOnly}
          required
          autoFocus
        />
      </label>
      <span className="composer-actions">
        <button type="submit" className="primary" disabled={readOnly || pending || text.trim() === ''}>
          {pending ? 'Sending…' : submitLabel}
          {!pending && (
            <kbd className="shortcut-hint" aria-hidden="true">
              ⌘↵
            </kbd>
          )}
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
        {result && (
          <span className={`small ${result.ok ? 'ok' : 'error'}`} role={result.ok ? 'status' : 'alert'}>
            {result.ok ? result.message : result.error}
          </span>
        )}
      </span>
    </form>
  );
}

type RowPanel = 'message' | 'details' | 'feedback' | null;
const RowContext = createContext<{ panel: RowPanel; show: (p: RowPanel) => void }>({
  panel: null,
  show: () => {},
});

/**
 * One session's row. Holds which panel under the pipeline is open (the message box or the details),
 * so the buttons inside the session node (server-rendered, deep in the pipeline) can open them. The
 * panels sit under the canvas, not on it: the canvas scrolls sideways and would clip a pop-up.
 */
export function SessionRowShell({
  sessionId,
  title,
  readOnly,
  paused = false,
  details,
  feedback,
  children,
}: {
  sessionId: number;
  title: string;
  readOnly: boolean;
  /** A paused session is resumed by a message; say so before it is sent. */
  paused?: boolean;
  details: ReactNode;
  /** What a stage sent back to the builder; opened by the feedback chip on the Builder node. */
  feedback?: ReactNode;
  children: ReactNode;
}) {
  const [panel, setPanel] = useState<RowPanel>(null);
  const show = (p: RowPanel) => setPanel((current) => (current === p ? null : p));
  return (
    <RowContext.Provider value={{ panel, show }}>
      <li className="session-row" data-testid="session-row" data-session-id={sessionId}>
        {children}
        {panel === 'details' && details}
        {panel === 'feedback' && feedback}
        {panel === 'message' && (
          <Composer
            label={`Message to “${title}”${paused ? ' (it is paused: sending resumes it)' : ''}`}
            placeholder="e.g. Also handle refunds"
            submitLabel="Send to session"
            send={(text) => messageSession(sessionId, text)}
            onClose={() => setPanel(null)}
            readOnly={readOnly}
            testId="session-composer"
          />
        )}
      </li>
    </RowContext.Provider>
  );
}

/** The "+" on a session node: opens the message box under its row. */
export function MessageButton() {
  const { panel, show } = useContext(RowContext);
  return (
    <button
      type="button"
      className="node-plus"
      onClick={() => show('message')}
      aria-expanded={panel === 'message'}
      aria-label="Send a message to this session"
      title="Send a message to this session"
      data-testid="session-plus"
    >
      +
    </button>
  );
}

/** What a terminal shows: a session's live agent, or the job log of one of a PR's stages. */
export type { TerminalTarget };

function useOpenTerminal(target: TerminalTarget, readOnly: boolean) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const open = () => {
    if (readOnly || pending) return;
    start(async () => {
      const r =
        target.kind === 'session'
          ? await openTerminal(target.sessionId)
          : await openStageTerminal(target.prId, target.stage);
      setError(r.ok ? null : r.error);
    });
  };
  return { open, pending, error };
}

/** ">_" on a node: opens its terminal on this Mac. A failure shows on hover. */
export function TerminalButton({ target, readOnly }: { target: TerminalTarget; readOnly: boolean }) {
  const { open, pending, error } = useOpenTerminal(target, readOnly);
  const what = target.kind === 'session' ? "this session's terminal" : `the ${target.stage} agent's terminal`;
  return (
    <button
      type="button"
      className={`node-terminal${error ? ' failed' : ''}`}
      disabled={readOnly || pending}
      onClick={open}
      // A double-click on the button itself is still one window: the node's double-click skips it.
      onDoubleClick={(e) => e.stopPropagation()}
      aria-label={error ? `Terminal: ${error}` : `Open ${what}`}
      title={error ?? `Open ${what} (or double-click the node)`}
      data-testid={target.kind === 'session' ? 'session-terminal' : 'stage-terminal'}
    >
      {'>_'}
    </button>
  );
}

/** Double-clicking anything inside opens the terminal (the node keeps its own layout: display contents). */
export function DoubleClickTerminal({
  target,
  readOnly,
  children,
}: {
  target: TerminalTarget;
  readOnly: boolean;
  children: ReactNode;
}) {
  const { open } = useOpenTerminal(target, readOnly);
  return (
    <span
      className="dblclick-terminal"
      onDoubleClick={(e) => {
        // Double-clicks on the node's own controls (answer buttons, links) are not for the terminal.
        if ((e.target as HTMLElement).closest('button, a, input, textarea')) return;
        open();
      }}
    >
      {children}
    </span>
  );
}

/** Click to open what a stage sent back to the builder: a chip on the Builder node, amber. */
export function FeedbackButton({
  label,
  className = 'node-feedback',
  testId = 'session-feedback-toggle',
}: {
  label: string;
  className?: string;
  testId?: string;
}) {
  const { panel, show } = useContext(RowContext);
  return (
    <button
      type="button"
      className={className}
      onClick={() => show('feedback')}
      aria-expanded={panel === 'feedback'}
      aria-label="Show what a stage sent back to the builder"
      title="What a stage sent back to the builder"
      data-testid={testId}
    >
      {label}
    </button>
  );
}

/** "⋯" on the Planner node: the plan, what runs the session, its subagents, and End session. */
export function DetailsButton() {
  const { panel, show } = useContext(RowContext);
  return (
    <button
      type="button"
      className="node-more"
      onClick={() => show('details')}
      aria-expanded={panel === 'details'}
      aria-label="Plan and session details"
      title="Plan and session details"
      data-testid="session-more"
    >
      ⋯
    </button>
  );
}

type ProjectPanel = 'new' | 'settings' | null;
const ProjectContext = createContext<{ panel: ProjectPanel; show: (p: ProjectPanel) => void }>({
  panel: null,
  show: () => {},
});

/** A project's section. Holds which panel under its header is open: a new session, or settings. */
export function ProjectShell({
  projectId,
  projectName,
  header,
  settings,
  readOnly,
  rowCount,
  children,
}: {
  projectId: number;
  projectName: string;
  header: ReactNode;
  settings: ReactNode;
  readOnly: boolean;
  /** How many pipelines the server rendered, to tell when a started session's real row has arrived. */
  rowCount: number;
  children: ReactNode;
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<ProjectPanel>(null);
  const [starting, setStarting] = useState<Starting[]>([]);
  const show = (p: ProjectPanel) => setPanel((current) => (current === p ? null : p));
  const shown = visibleStarting(starting, rowCount);

  // The server turns the request into a session a moment later: ask for the board a few times.
  const started = (text: string) => {
    setStarting((list) => [
      ...list,
      { id: Date.now() + list.length, text, after: startingAfter(list, rowCount) },
    ]);
    setPanel(null);
    router.refresh();
    for (const ms of [1000, 3000, 6000, 12000]) setTimeout(() => router.refresh(), ms);
  };
  // A placeholder whose row never shows (the request failed server-side) must not stay forever.
  useEffect(() => {
    if (starting.length === 0) return;
    const t = setTimeout(
      () => setStarting((list) => list.filter((s) => Date.now() - s.id < 120_000)),
      125_000,
    );
    return () => clearTimeout(t);
  }, [starting]);
  return (
    <ProjectContext.Provider value={{ panel, show }}>
      <section className="project" data-testid="project" data-project={projectName}>
        {header}
        {panel === 'new' && (
          <Composer
            label={`New session in ${projectName}`}
            placeholder="What should be done? e.g. Add a dark mode"
            submitLabel="Start session"
            send={(text) => createRequest(text, projectId)}
            onClose={() => setPanel(null)}
            onSent={started}
            readOnly={readOnly}
            testId="project-composer"
            rows={8}
          />
        )}
        {panel === 'settings' && <div className="project-settings-panel">{settings}</div>}
        {shown.length > 0 && (
          <ul className="rows starting-rows">
            {shown.map((s) => (
              <StartingPipeline key={s.id} text={s.text} />
            ))}
          </ul>
        )}
        {children}
      </section>
    </ProjectContext.Provider>
  );
}

/** "+ Session" and the settings gear in a project's header. */
export function ProjectButtons({ projectName }: { projectName: string }) {
  const { panel, show } = useContext(ProjectContext);
  return (
    <span className="project-buttons">
      <button
        type="button"
        className="secondary small"
        aria-expanded={panel === 'new'}
        onClick={() => show('new')}
        data-testid="project-plus"
      >
        + Session
      </button>
      <button
        type="button"
        className="ghost small icon-button"
        aria-expanded={panel === 'settings'}
        aria-label={`Settings for ${projectName}`}
        title="Project settings"
        onClick={() => show('settings')}
        data-testid="project-settings-toggle"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
          <circle cx="15" cy="7" r="2" />
          <circle cx="9" cy="17" r="2" />
        </svg>
      </button>
    </span>
  );
}
