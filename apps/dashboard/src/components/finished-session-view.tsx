'use client';

import { useState } from 'react';
import type { z } from 'zod';
import { responses } from '../lib/schemas';

/** The session's transcript (or null) as the server sends it. */
type Stored = NonNullable<z.infer<typeof responses.transcript>>['transcript'];

/** What the panel shows: still fetching, none stored, the text, or the fetch failed. */
type LoadStatus = 'loading' | 'none' | 'shown' | 'failed';

/**
 * The "View" on a finished session row: opens the session's stored transcript under the row. The
 * transcript comes from this app's same-origin relay (/api/sessions/:id/transcript, cookie
 * authenticated). A transcript is fetched once and kept; a failure is forgotten, so reopening the
 * panel retries the fetch.
 */
export function FinishedSessionView({ sessionId }: { sessionId: number }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [transcript, setTranscript] = useState<Stored>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    // Only a kept transcript is reused: after a failure the next open retries the fetch.
    if (!next || status === 'shown') return;
    setStatus('loading');
    try {
      const res = await fetch(`/api/sessions/${sessionId}/transcript`, { cache: 'no-store' });
      const parsed = responses.transcript.safeParse(await res.json().catch(() => undefined));
      if (!res.ok || !parsed.success) throw new Error('failed');
      const stored = parsed.data.transcript;
      if (stored === null) setStatus('none');
      else {
        setTranscript(stored);
        setStatus('shown');
      }
    } catch {
      setStatus('failed');
    }
  };

  const body =
    status === 'shown'
      ? transcript?.text
      : status === 'none'
        ? 'No transcript stored for this session.'
        : status === 'failed'
          ? 'The transcript could not be loaded.'
          : 'Loading…';

  return (
    <>
      <button
        type="button"
        className="ghost small"
        onClick={() => void toggle()}
        aria-expanded={open}
        data-testid="finished-view"
      >
        {open ? 'Hide' : 'View'}
      </button>
      {open && (
        <div className="finished-transcript" data-testid="finished-transcript">
          <pre className="transcript" data-testid="finished-transcript-text">
            {body}
          </pre>
        </div>
      )}
    </>
  );
}
