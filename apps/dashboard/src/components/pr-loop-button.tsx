'use client';

import { useState, useTransition } from 'react';
import { prLoop } from '../app/actions';
import { Dialog } from './dialog';

const TEXT = {
  'take-over': {
    button: 'Take over',
    title: (pr: string) => `Take over ${pr}?`,
    body: 'The loop stops working on it, a running check is stopped, and it will not merge it. You can put it back later.',
  },
  retry: {
    button: 'Back in the loop',
    title: (pr: string) => `Put ${pr} back in the loop?`,
    body: 'Every check runs again on the PR’s current head, and it can merge if they pass.',
  },
};

/**
 * On a PR's lane: take it out of the loop or put it back. This works after a question's deadline,
 * when an answer to the question itself is refused.
 */
export function PrLoopButton({
  prId,
  pr,
  action,
  readOnly,
}: {
  prId: number;
  /** "web#12", for the pop-up. */
  pr: string;
  action: 'take-over' | 'retry';
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const text = TEXT[action];
  const confirm = () =>
    start(async () => {
      const result = await prLoop(prId, action).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      }));
      if (result.ok) setOpen(false);
      else setError(result.error);
    });
  return (
    <>
      <button
        type="button"
        className="node-skip"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        data-testid="pr-loop"
      >
        {text.button}
      </button>
      {open && (
        <Dialog label={text.button} onClose={() => setOpen(false)} testId="pr-loop-dialog">
          <h2>{text.title(pr)}</h2>
          <p className="muted">{text.body}</p>
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
              data-testid="pr-loop-confirm"
            >
              {text.button}
            </button>
            <button type="button" className="ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
