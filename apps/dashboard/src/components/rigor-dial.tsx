'use client';

import { useOptimistic, useRef, useState, useTransition, type KeyboardEvent } from 'react';
import { setRigor } from '../app/actions';
import { RIGOR_LEVELS, type Rigor } from '../lib/schemas';

const NAMES: Record<Rigor, string> = {
  fast: 'Fast',
  light: 'Light',
  standard: 'Standard',
  thorough: 'Thorough',
};

/** One line on what the level does to this session's PRs (the loop's policy: packages/loop/src/rigor.ts). */
export const RIGOR_CAPTIONS: Record<Rigor, string> = {
  fast: 'no checks, merges once CI passes',
  light: 'tests and code review only, 2 rounds at most',
  standard: 'the pipeline as it is',
  thorough: 'every check, QA on every PR, tests for every change',
};

/** Where an arrow, Home or End key goes from stop `from` (null: another key). */
function moveFrom(key: string, from: number, last: number): number | null {
  if (key === 'ArrowRight' || key === 'ArrowDown') return Math.min(from + 1, last);
  if (key === 'ArrowLeft' || key === 'ArrowUp') return Math.max(from - 1, 0);
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  return null;
}

function LevelIcon({ level }: { level: Rigor }) {
  if (level !== 'fast' && level !== 'thorough') return null;
  return (
    <svg
      className="rigor-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {level === 'fast' ? (
        <path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />
      ) : (
        <>
          <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />
          <path d="m9 12 2 2 4-4" />
        </>
      )}
    </svg>
  );
}

/**
 * The rigor dial above a session's pipeline: one choice from fast and cheap to slow and safe. A
 * radiogroup (arrow keys move and choose, like any radio group); a choice is saved at once and the
 * pipeline under it redraws with the checks that level leaves out turned off. Read-only in demo
 * mode; inert in the editor's preview.
 */
export function RigorDial({
  sessionId,
  title,
  rigor,
  readOnly,
  preview = false,
}: {
  sessionId: number;
  /** The session's title, for the group's accessible name. */
  title: string;
  rigor: Rigor;
  readOnly: boolean;
  /** The editor's preview: drawn, never changed. */
  preview?: boolean;
}) {
  const [shown, setShown] = useOptimistic(rigor);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const stops = useRef<(HTMLButtonElement | null)[]>([]);
  const locked = readOnly || preview;

  const choose = (level: Rigor) => {
    if (locked || level === shown) return;
    setError(null);
    start(async () => {
      setShown(level);
      const result = await setRigor(sessionId, level);
      if (!result.ok) setError(result.error);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Read-only, the arrows only move focus along the dial (choose() ignores the change).
    const focused = stops.current.indexOf(document.activeElement as HTMLButtonElement);
    const from = locked && focused >= 0 ? focused : RIGOR_LEVELS.indexOf(shown);
    const to = moveFrom(e.key, from, RIGOR_LEVELS.length - 1);
    if (to === null) return;
    e.preventDefault();
    stops.current[to]?.focus();
    choose(RIGOR_LEVELS[to]!);
  };

  return (
    <div
      className={`rigor rigor-${shown}`}
      data-testid="rigor-dial"
      data-rigor={shown}
      aria-busy={pending || undefined}
      inert={preview}
    >
      <div
        className="rigor-track"
        role="radiogroup"
        aria-label={`Rigor for ${title}`}
        aria-describedby={`rigor-caption-${sessionId}`}
        aria-disabled={locked || undefined}
        title={readOnly && !preview ? 'Demo data is read-only.' : undefined}
        onKeyDown={onKeyDown}
      >
        {RIGOR_LEVELS.map((level, i) => (
          <button
            key={level}
            ref={(el) => {
              stops.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={level === shown}
            // Roving focus: Tab lands on the chosen level, arrows move between them.
            tabIndex={level === shown ? 0 : -1}
            className={`rigor-stop rigor-stop-${level}`}
            data-testid={`rigor-${level}`}
            // Not `disabled`: in demo mode the group stays reachable by keyboard; choose() ignores it.
            aria-disabled={readOnly || undefined}
            onClick={() => choose(level)}
          >
            <LevelIcon level={level} />
            {NAMES[level]}
          </button>
        ))}
      </div>
      <div className="rigor-axis" aria-hidden="true">
        <span>← Faster · cheaper</span>
        <span>Safer · thorough →</span>
      </div>
      <p className="rigor-caption" id={`rigor-caption-${sessionId}`} data-testid="rigor-caption">
        <strong>{NAMES[shown]}:</strong> {RIGOR_CAPTIONS[shown]}
        {readOnly && !preview && <span className="sr-only"> Demo data is read-only.</span>}
      </p>
      {error && (
        <p className="error small rigor-note" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
