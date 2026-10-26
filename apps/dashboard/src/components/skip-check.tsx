'use client';

import { createContext, useContext, useOptimistic, useState, useTransition, type ReactNode } from 'react';
import { skipCheck } from '../app/actions';
import { Dialog } from './dialog';

/**
 * Whether a check is skipped for one PR, as its node shows it: the server's value, or the owner's
 * choice from the moment they confirm until the server answers (the lane is server-rendered, so the
 * refreshed props take over then; a failed save falls back to the server's value).
 */
const SkipContext = createContext<{ skipped: boolean; show: (skipped: boolean) => void } | null>(null);

export function SkipState({ skipped, children }: { skipped: boolean; children: ReactNode }) {
  const [shown, show] = useOptimistic(skipped);
  return <SkipContext value={{ skipped: shown, show }}>{children}</SkipContext>;
}

/** The node's detail word, which follows the shown skip at once; none for an empty word. */
export function SkipDetail({ skipped, unskipped }: { skipped: string; unskipped: string }) {
  const word = useContext(SkipContext)?.skipped ? skipped : unskipped;
  return word ? <span className="node-detail">{word}</span> : null;
}

/**
 * "Skip" under a check's node in a PR's lane, or "Run again" once skipped. Either way a pop-up says
 * what happens and asks first. Confirming flips the node at once and saves in the background; a
 * failure flips it back and reopens the pop-up with the error. Used inside a SkipState.
 */
export function SkipCheck({
  prId,
  pr,
  check,
  label,
  readOnly,
}: {
  prId: number;
  /** "web#12", for the pop-up. */
  pr: string;
  check: string;
  label: string;
  readOnly: boolean;
}) {
  const state = useContext(SkipContext);
  const skipped = state?.skipped ?? false;
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const confirm = () => {
    const skip = !skipped;
    setError(null);
    setOpen(false);
    start(async () => {
      state?.show(skip);
      const result = await skipCheck(prId, check, skip).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      }));
      // Part of the transition, so the pop-up comes back as the node flips back, not before.
      if (!result.ok)
        start(() => {
          setError(result.error);
          setOpen(true);
        });
    });
  };
  return (
    <>
      <button
        type="button"
        className="node-skip"
        aria-label={skipped ? `Run ${label} again for ${pr}` : `Skip ${label} for ${pr}`}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        data-testid="skip-check"
      >
        {skipped ? 'Run again' : 'Skip'}
      </button>
      {/* The node opens its terminal on a double-click; one inside the pop-up must not reach it. */}
      {open && (
        <span className="contents" onDoubleClick={(e) => e.stopPropagation()}>
          <Dialog
            label={skipped ? `Run ${label} again` : `Skip ${label}`}
            onClose={() => setOpen(false)}
            testId="skip-dialog"
          >
            <h2>{skipped ? `Run ${label} again for ${pr}?` : `Skip ${label} for ${pr}?`}</h2>
            <p className="muted">
              {skipped
                ? 'The loop runs it before the merge, on the PR’s current head.'
                : 'The loop counts it as passed for this PR, now and after new commits, until you bring it back. CI still has to pass before the merge.'}
            </p>
            {!skipped && check === 'review' && (
              <p className="warning small">Without a code review, the PR waits for your merge approval.</p>
            )}
            {error && (
              <p className="error small" role="alert">
                {error}
              </p>
            )}
            <div className="row-actions">
              <button
                type="button"
                disabled={pending || readOnly}
                onClick={confirm}
                data-testid="skip-confirm"
              >
                {skipped ? `Run ${label} again` : `Skip ${label}`}
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
