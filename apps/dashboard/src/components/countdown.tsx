'use client';

import { useEffect, useState } from 'react';
import { formatCountdown } from '../lib/format';

/** A small ring that empties as the deadline nears. */
function Ring({ left }: { left: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg className="countdown-ring" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r={r} className="countdown-ring-track" />
      <circle
        cx="8"
        cy="8"
        r={r}
        className="countdown-ring-left"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - left)}
        suppressHydrationWarning
      />
    </svg>
  );
}

/**
 * Time left until a question's deadline, ticking every second, with a ring for the share left.
 * When it runs out the question goes with `fallback` (its recommended option); hovering says so.
 */
export function Countdown({
  createdAt,
  deadline,
  fallback,
}: {
  createdAt: string;
  deadline: string;
  fallback: string;
}) {
  const end = Date.parse(deadline);
  const total = Math.max(1, end - Date.parse(createdAt));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const left = end - now;
  const urgent = left < 3 * 60_000;
  const share = Math.min(1, Math.max(0, left / total));
  return (
    <span
      className={`countdown${urgent ? ' urgent' : ''}`}
      data-testid="countdown"
      title={`With no answer, it goes with "${fallback}"`}
    >
      <Ring left={share} />
      <span className="countdown-time" suppressHydrationWarning>
        {left > 0 ? `${formatCountdown(left)} left` : 'Defaulting now…'}
      </span>
      <span className="sr-only">, then it goes with {fallback}</span>
    </span>
  );
}
