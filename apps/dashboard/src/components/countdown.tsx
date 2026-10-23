'use client';

import { useEffect, useState } from 'react';
import { formatCountdown } from '../lib/format';

/** Time left until a question's deadline, ticking every second, with a bar for the 15 minutes. */
export function Countdown({ createdAt, deadline }: { createdAt: string; deadline: string }) {
  const end = Date.parse(deadline);
  const total = Math.max(1, end - Date.parse(createdAt));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const left = end - now;
  const urgent = left < 3 * 60_000;
  return (
    <div className={`countdown${urgent ? ' urgent' : ''}`} data-testid="countdown">
      <span className="countdown-time" suppressHydrationWarning>
        {left > 0 ? `${formatCountdown(left)} left` : 'Defaulting now…'}
      </span>
      <span className="countdown-label">{urgent ? 'Defaults soon' : 'until the default'}</span>
      <span className="bar" aria-hidden="true">
        <span
          suppressHydrationWarning
          style={{ width: `${Math.min(100, Math.max(0, (left / total) * 100))}%` }}
        />
      </span>
    </div>
  );
}
