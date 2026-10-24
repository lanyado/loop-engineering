'use client';

import { useState, useTransition } from 'react';
import { skipCheck } from '../app/actions';
import { Dialog } from './dialog';

/**
 * "Skip" under a check's node in a PR's lane, or "Run again" once skipped. Either way a pop-up says
 * what happens and asks first.
 */
export function SkipCheck({
  prId,
  pr,
  check,
  label,
  skipped,
  readOnly,
}: {
  prId: number;
  /** "web#12", for the pop-up. */
  pr: string;
  check: string;
  label: string;
  skipped: boolean;
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const confirm = () =>
    start(async () => {
      const result = await skipCheck(prId, check, !skipped);
      if (result.ok) setOpen(false);
      else setError(result.error);
    });
  return (
    <>
      <button
        type="button"
        className="node-feedback"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        // The node opens its terminal on double-click; this button is not part of that.
        onDoubleClick={(e) => e.stopPropagation()}
        data-testid="skip-check"
      >
        {skipped ? 'Run again' : 'Skip'}
      </button>
      {open && (
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
            <button type="button" disabled={pending || readOnly} onClick={confirm} data-testid="skip-confirm">
              {skipped ? `Run ${label} again` : `Skip ${label}`}
            </button>
            <button type="button" className="ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          {readOnly && <p className="muted small">Demo data is read-only.</p>}
        </Dialog>
      )}
    </>
  );
}
