/** A report's time span: ISO UTC times, `since` included, `until` excluded. */
export interface RetroWindow {
  since: string;
  until: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar month (UTC) before the one `now` is in. */
export function previousMonth(now: Date): RetroWindow {
  const until = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const since = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

/** A date (YYYY-MM-DD, midnight UTC) or a full ISO time; `endOfDay` moves a bare date to the next midnight. */
function parseTime(value: string, flag: string, endOfDay: boolean): number {
  const v = value.trim();
  if (DATE.test(v)) {
    const t = Date.parse(`${v}T00:00:00.000Z`);
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v)
      throw new Error(`${flag} ${value} is not a date`);
    return endOfDay ? t + DAY_MS : t;
  }
  const t = v.includes('T') ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw new Error(`${flag} needs a date (YYYY-MM-DD) or an ISO time, not "${value}"`);
  return t;
}

export interface WindowFlags {
  since?: string;
  until?: string;
  days?: string;
}

/**
 * The window the flags describe. Dates are whole UTC days and both ends count (`--since 2026-10-01
 * --until 2026-10-31` is October); a full ISO time is used as given. `--days N` is the N days up to
 * now. No flags: the previous calendar month.
 */
export function windowFromFlags(flags: WindowFlags, now: Date): RetroWindow {
  if (flags.days !== undefined) {
    if (flags.since !== undefined || flags.until !== undefined)
      throw new Error('--days cannot be combined with --since or --until');
    const days = Number(flags.days);
    if (!Number.isInteger(days) || days < 1 || days > 3660)
      throw new Error(`--days needs a whole number of days (1 or more), not "${flags.days}"`);
    return {
      since: new Date(now.getTime() - days * DAY_MS).toISOString(),
      until: now.toISOString(),
    };
  }
  if (flags.since === undefined && flags.until === undefined) return previousMonth(now);
  if (flags.since === undefined) throw new Error('--until needs --since');
  const since = parseTime(flags.since, '--since', false);
  const until = flags.until === undefined ? now.getTime() : parseTime(flags.until, '--until', true);
  if (since >= until) throw new Error('--since must be before --until');
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

/** Exactly one calendar month (UTC): its YYYY-MM, else null. */
export function windowMonth(w: RetroWindow): string | null {
  const since = new Date(w.since);
  const exact = previousMonth(new Date(w.until));
  return exact.since === w.since && exact.until === w.until ? since.toISOString().slice(0, 7) : null;
}

/** "2026-10-01 to 2026-10-31" (the last day included), or the times when they are not midnights. */
export function describeWindow(w: RetroWindow): string {
  const midnight = (iso: string) => iso.endsWith('T00:00:00.000Z');
  if (midnight(w.since) && midnight(w.until)) {
    const last = new Date(Date.parse(w.until) - DAY_MS).toISOString().slice(0, 10);
    return `${w.since.slice(0, 10)} to ${last} (UTC)`;
  }
  return `${w.since.slice(0, 16).replace('T', ' ')} to ${w.until.slice(0, 16).replace('T', ' ')} (UTC)`;
}

/** A name safe as part of a file name. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * The report's file name: `YYYY-MM.md` for a calendar month, else `<first day>_to_<last day>.md`;
 * a report of one project ends in `-<project>`.
 */
export function retroFileName(w: RetroWindow, project?: { id: number; name: string }): string {
  const last = new Date(Date.parse(w.until) - 1).toISOString().slice(0, 10);
  const base = windowMonth(w) ?? `${w.since.slice(0, 10)}_to_${last}`;
  const suffix = project ? `-${slug(project.name) || `project-${project.id}`}` : '';
  return `${base}${suffix}.md`;
}
