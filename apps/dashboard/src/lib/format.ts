/** Display helpers shared by server and client components. Pure functions, unit tested. */

export const REVIEW_ROUND_CAP = 5;

/** Colour of a usage meter: calm, then amber from 70%, red from 90%. */
export function usageTone(usedPercentage: number): 'active' | 'waiting' | 'bad' {
  if (usedPercentage >= 90) return 'bad';
  if (usedPercentage >= 70) return 'waiting';
  return 'active';
}

export function roundLabel(round: number): string {
  return `round ${round}/${REVIEW_ROUND_CAP}`;
}

const PAUSE_LABELS: Record<string, string> = {
  manual: 'paused by you',
  usage_limit: 'usage limit',
  agent_exited: 'agent exited',
};

export function pauseLabel(reason: string | null): string | null {
  return reason === null ? null : (PAUSE_LABELS[reason] ?? humanize(reason));
}

const PERMISSION_LABELS: Record<string, string> = {
  auto: 'Auto (classifier approves)',
  manual: 'Manual (always ask)',
  acceptEdits: 'Accept edits',
  plan: 'Plan only',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
};

export function permissionLabel(mode: string): string {
  return PERMISSION_LABELS[mode] ?? mode;
}

export function humanize(value: string): string {
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "14:05" for minutes:seconds left; "0:00" once due. */
export function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** "45s", "12m", "3h 12m", "4d 2h": how long something has been running. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

/** Time a session has run: until it ended, or until now. */
export function sessionRuntime(createdAt: string, endedAt: string | null, nowMs: number): string {
  const end = endedAt === null ? nowMs : Date.parse(endedAt);
  return formatDuration(end - Date.parse(createdAt));
}

/** "15 Oct 2026": the day something happened, in `timeZone` (default: the server's). */
export function formatDay(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

/** "14:05": the time of day, in `timeZone` (default: the server's). */
export function formatClock(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

/** Finished sessions, the most recently ended first (ties: newest id first). */
export function newestFinishedFirst<T extends { id: number; createdAt: string; endedAt: string | null }>(
  sessions: readonly T[],
): T[] {
  const key = (s: T) => s.endedAt ?? s.createdAt;
  return [...sessions].sort((a, b) => key(b).localeCompare(key(a)) || b.id - a.id);
}

export function formatAgo(iso: string, nowMs: number): string {
  const ms = nowMs - Date.parse(iso);
  return ms < 30_000 ? 'just now' : `${formatDuration(ms)} ago`;
}

/** Parses the allowlist box: IDs separated by commas, spaces or new lines. */
export function parseIdList(text: string): { ids: number[]; invalid: string[] } {
  const ids: number[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    if (/^\d{1,16}$/.test(part) && Number(part) > 0 && Number.isSafeInteger(Number(part))) {
      if (!ids.includes(Number(part))) ids.push(Number(part));
    } else {
      invalid.push(part);
    }
  }
  return { ids, invalid };
}

/** "842", "128k", "1.9M": a token count in a few characters. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${Number((count / 1_000_000).toFixed(1))}M`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One PR's loop metrics: "$0.42 · 128k tokens · 2 rounds · 1 failure" (no failures: that part is left out). */
export function formatPrMetrics(m: {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  rounds: number;
  failures: number;
}): string {
  return [
    `$${m.costUsd.toFixed(2)}`,
    `${formatTokens(m.tokensIn + m.tokensOut)} tokens`,
    plural(m.rounds, 'round'),
    ...(m.failures > 0 ? [plural(m.failures, 'failure')] : []),
  ].join(' · ');
}
