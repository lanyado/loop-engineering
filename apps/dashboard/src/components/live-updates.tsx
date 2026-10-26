'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

/** How often to re-render anyway: PR stages and sessions change without question events. */
const POLL_MS = 30_000;

/**
 * Listens to /api/events (the dashboard's same-origin relay of the server's SSE stream, so the
 * cookie authenticates it and no token reaches the browser) and re-renders the page's server
 * components whenever a question is created or resolved, a new task arrives, or a session's plan comes in.
 *
 * It renders nothing: the connection state used to show in the top bar ("Live"), and that
 * indicator was dropped. The stream and the 30-second poll stay on, so the board still updates
 * itself; in demo mode nothing changes, so no stream is opened.
 */
export function LiveUpdates({ demo }: { demo: boolean }) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (demo) return;
    const refreshSoon = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), 150); // coalesce bursts
    };
    const source = new EventSource('/api/events');
    source.addEventListener('question.created', refreshSoon);
    source.addEventListener('question.resolved', refreshSoon);
    source.addEventListener('request.created', refreshSoon);
    source.addEventListener('session.planned', refreshSoon);
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshSoon();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      source.close();
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [router, demo]);

  return null;
}
