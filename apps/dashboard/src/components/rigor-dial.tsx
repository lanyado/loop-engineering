'use client';

import { useOptimistic, useRef, useState, useTransition, type KeyboardEvent } from 'react';
import { setRigor } from '../app/actions';
import { rigorHint } from '../lib/format';
import { RIGOR_LEVELS, type Rigor, type RigorSource } from '../lib/schemas';

const NAMES: Record<Rigor, string> = {
  fast: 'Fast',
  light: 'Light',
  standard: 'Standard',
  thorough: 'Thorough',
};

/** One line on what the level does to this session's PRs (the loop's policy: packages/loop/src/rigor.ts). */
export const RIGOR_CAPTIONS: Record<Rigor, string> = {
  fast: 'same stages, low effort, quick checks, no new tests, 1 review round',
  light: 'same stages, medium effort, quick checks, no new tests, 2 rounds at most',
  standard: 'the pipeline as it is',
  thorough: 'same stages, maximum effort, tests for every change, QA on every PR',
};

/** Where an arrow, Home or End key goes from stop `from` (null: another key). */
function moveFrom(key: string, from: number, last: number): number | null {
  if (key === 'ArrowRight' || key === 'ArrowDown') return Math.min(from + 1, last);
  if (key === 'ArrowLeft' || key === 'ArrowUp') return Math.max(from - 1, 0);
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  return null;
}

/**
 * The rigor dial above a session's pipeline: one choice from fast and cheap to slow and safe. A
 * radiogroup (arrow keys move and choose, like any radio group); a choice is saved at once, and from
 * then on the Planner no longer changes it. Read-only in demo mode; inert in the editor's preview.
 */
export function RigorDial({
  sessionId,
  title,
  rigor,
  source = 'default',
  reason = null,
  readOnly,
  preview = false,
}: {
  sessionId: number;
  /** The session's title, for the group's accessible name. */
  title: string;
  rigor: Rigor;
  /** Who chose the level: choosing the shown level still saves while the human has not (it pins it). */
  source?: RigorSource;
  /** Why the Planner chose the level. */
  reason?: string | null;
  readOnly: boolean;
  /** The editor's preview: drawn, never changed. */
  preview?: boolean;
}) {
  const [shown, setShown] = useOptimistic(rigor);
  const [pinned, setPinned] = useOptimistic(source === 'human');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const stops = useRef<(HTMLButtonElement | null)[]>([]);
  const locked = readOnly || preview;
  const hint = rigorHint(shown === rigor, pinned, source, reason);

  const choose = (level: Rigor) => {
    if (locked || (level === shown && pinned)) return;
    setError(null);
    start(async () => {
      setShown(level);
      setPinned(true);
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
      className="rigor"
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
            title={`${NAMES[level]}: ${RIGOR_CAPTIONS[level]}${level === shown ? hint : ''}`}
            onClick={() => choose(level)}
          >
            {NAMES[level]}
          </button>
        ))}
      </div>
      {/* The words for the chosen level, for screen readers; sighted users get it on hover. */}
      <p className="rigor-caption sr-only" id={`rigor-caption-${sessionId}`} data-testid="rigor-caption">
        <strong>{NAMES[shown]}:</strong> {RIGOR_CAPTIONS[shown]}
        {hint}
      </p>
      {error && (
        <p className="error small rigor-note" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
