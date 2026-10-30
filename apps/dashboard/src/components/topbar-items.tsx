import Link from 'next/link';
import { formatAgo, formatDuration, usageTone } from '../lib/format';
import type { ClaudeUsage, UsageWindow } from '../lib/schemas';
import { Logo } from './logo';

/** A snapshot older than this is shown as stale: no Claude Code session has rendered its status line since. */
const STALE_MS = 30 * 60_000;

/**
 * The Claude mark: a small stroke starburst, as the limits these meters watch are Claude Code's.
 */
function ClaudeMark() {
  return (
    <span className="claude-mark" data-testid="claude-mark" title="Claude Code usage limits">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        aria-hidden="true"
        focusable="false"
      >
        {/* Rays every 30°: long to the axes, short to the diagonals, like Claude's starburst. */}
        <path d="M12 1.8v5.4M12 16.8v5.4M1.8 12h5.4M16.8 12h5.4M4.6 4.6l3.8 3.8M15.6 15.6l3.8 3.8M19.4 4.6l-3.8 3.8M8.4 15.6l-3.8 3.8" />
      </svg>
      Claude
    </span>
  );
}

function Meter({ label, window, now }: { label: string; window: UsageWindow | null; now: number }) {
  if (!window) return null;
  const used = Math.round(window.usedPercentage);
  const reset = Date.parse(window.resetsAt) - now;
  return (
    <div className={`meter ${usageTone(used)}`} data-testid="usage-meter" data-window={label}>
      <span className="meter-head">
        <span className="meter-label">{label}</span>
        <span className="meter-value">{used}%</span>
      </span>
      <span
        className="meter-bar"
        role="meter"
        aria-label={`${label} limit used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
      >
        <span style={{ width: `${used}%` }} />
      </span>
      <span className="meter-reset">{reset > 0 ? `resets in ${formatDuration(reset)}` : 'reset'}</span>
    </div>
  );
}

/** One usage limit; a note while none were captured yet. */
function Limit({
  window,
  usage,
  now,
}: {
  window: 'fiveHour' | 'weekly';
  usage: ClaudeUsage | null;
  now: number;
}) {
  const captured = usage && (usage.fiveHour || usage.sevenDay);
  if (!captured)
    return (
      <span
        className="usage-missing muted small"
        data-testid="usage-missing"
        title="Pipe your status line JSON into scripts/capture-claude-usage.sh (see README)."
      >
        {window === 'fiveHour' ? '5-hour' : 'Weekly'}: not captured yet
      </span>
    );
  return window === 'fiveHour' ? (
    <Meter label="5-hour" window={usage.fiveHour} now={now} />
  ) : (
    <Meter label="Weekly" window={usage.sevenDay} now={now} />
  );
}

/** The top bar: the logo, the Claude mark and both usage limits, then a note when the limits are old. */
export function TopbarItems({ usage, now }: { usage: ClaudeUsage | null; now: number }) {
  const stale = usage && now - Date.parse(usage.capturedAt) > STALE_MS;
  return (
    <div className="topbar-items" data-testid="topbar-items">
      <Link href="/" className="brand">
        <Logo />
        Loop
      </Link>
      <ClaudeMark />
      <Limit window="fiveHour" usage={usage} now={now} />
      <Limit window="weekly" usage={usage} now={now} />
      {stale && (
        <span className="usage-stale muted small" data-testid="usage-stale">
          as of {formatAgo(usage.capturedAt, now)}
        </span>
      )}
    </div>
  );
}
