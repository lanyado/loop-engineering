'use client';

import { useState, useTransition } from 'react';
import { endSession, type ActionResult } from '../app/actions';

/**
 * "End session" with a confirm step: the first tap asks, the second ends it. Ending stops the agent
 * and removes the session's worktrees; a folder project's files are left as they are.
 */
export function EndSessionButton({
  sessionId,
  folder,
  readOnly,
}: {
  sessionId: number;
  folder: boolean;
  readOnly: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const end = () =>
    start(async () => {
      const r = await endSession(sessionId);
      setResult(r);
      if (r.ok) setConfirming(false);
    });
  return (
    <div className="end-session" data-testid="end-session">
      {confirming ? (
        <>
          <span className="small">
            {folder
              ? 'End it? The agent stops; the files in the folder stay as they are.'
              : 'End it? The agent stops and its worktrees are removed (refused with uncommitted changes).'}
          </span>
          <span className="end-session-actions">
            <button
              type="button"
              className="danger"
              onClick={end}
              disabled={pending}
              data-testid="end-session-confirm"
            >
              {pending ? 'Ending…' : 'Yes, end it'}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setConfirming(false)}
              disabled={pending}
            >
              Keep it
            </button>
          </span>
        </>
      ) : (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setResult(null);
            setConfirming(true);
          }}
          disabled={readOnly}
          data-testid="end-session-button"
        >
          End session
        </button>
      )}
      {result && !result.ok && (
        <span className="small error" role="alert">
          {result.error}
        </span>
      )}
    </div>
  );
}
