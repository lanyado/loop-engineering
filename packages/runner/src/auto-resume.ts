import { errorMessage, type Session, type Store } from '@loop-engineering/core';
import type { SessionRunner, TmuxServerDeath } from './runner.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The wait before each automatic resume, by how many came before it in the window. */
const WAITS_MS = [1 * MINUTE, 5 * MINUTE, 15 * MINUTE];
const MAX_RESUMES = WAITS_MS.length;
/** Automatic resumes are counted over this rolling window (and since the session's newest task). */
const WINDOW_MS = 24 * HOUR;

// In the session's history, so counts survive a server restart. A failed try counts like one that
// worked: a launch that keeps failing must reach the owner too.
const RESUMED = 'Auto-resume:';
const STOPPED = 'Auto-resume stopped';
const TMUX_GONE = 'The tmux server';

/** Why the agent is resumed, for its first prompt ("Resumed: <this>. Continue where you left off."). */
export const AUTO_RESUME_REASON =
  'your terminal closed (its tmux window went away; you did not cause it). Your worktree is intact, but any ' +
  'background command you had running died with it, and its log may end early, so do not trust a partial log. ' +
  'Rerun what you were waiting on, then carry on with your task';

export interface AutoResumeOptions {
  now: () => number;
  /** The owner should know: several agents went at once, or one keeps exiting. */
  onAlert?: (session: Session, message: string) => void;
  log?: (message: string) => void;
}

function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

const iso = (ms: number) => new Date(ms).toISOString();

function listIds(sessions: readonly Session[]): string {
  const ids = sessions
    .map((s) => s.id)
    .sort((a, b) => a - b)
    .map(String);
  return ids.length < 2 ? (ids[0] ?? '') : `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)!}`;
}

/**
 * Nobody watches the agents' terminals, so a session whose agent went away by itself (paused as
 * agent_exited: a crash, a closed window, the tmux server dying) is resumed after a short wait, at
 * most MAX_RESUMES times in WINDOW_MS, then the owner hears once. A session with a PR in the loop is
 * the loop's: it resumes its builder when the PR needs it (the feedback goes in its first prompt).
 */
export class AutoResume {
  /** Sessions waiting to be resumed -> since when (first seen paused, or the last failed try). */
  private readonly waiting = new Map<number, number>();

  constructor(
    private readonly runner: SessionRunner,
    private readonly store: Store,
    private readonly options: AutoResumeOptions,
  ) {}

  /**
   * After the pass's reconcile found `exited`: records a tmux server that died holding them, and
   * tells the owner once when several agents (or the server) went at once.
   */
  async afterReconcile(exited: readonly Session[]): Promise<void> {
    const death = await this.runner.checkTmuxServer(exited.length > 0, this.options.now());
    if (death) this.recordDeath(death, exited);
    if (exited.length < 2 && !(death && exited.length > 0)) return;
    const server = death
      ? ` The tmux server holding them (pid ${death.pid}) died: it ran for ${duration(death.lastSeenAt - death.startedAt)} and was last seen alive at ${iso(death.lastSeenAt)}.`
      : '';
    const message =
      `Sessions ${listIds(exited)} lost their agents at once.${server} Each is resumed automatically ` +
      `(at most ${MAX_RESUMES} times in 24 hours), except a folder session, which is ended, and one with a PR ` +
      'in the loop, which the loop resumes when the PR needs it. You hear again only if that stops working.';
    this.options.log?.(`[runner] ${message}`);
    const at = exited.find((s) => s.status !== 'ended') ?? exited[0]!;
    this.options.onAlert?.(at, message);
  }

  /** Resumes the sessions that are due. `skip`: sessions another part of the monitor is relaunching. */
  async run(skip: ReadonlySet<number> = new Set()): Promise<void> {
    const now = this.options.now();
    const exited = this.store.sessions
      .list({ status: 'paused' })
      .filter((s) => s.pauseReason === 'agent_exited' && !skip.has(s.id) && this.ours(s));
    for (const id of this.waiting.keys()) if (!exited.some((s) => s.id === id)) this.waiting.delete(id);
    for (const s of exited) {
      const since = this.waiting.get(s.id) ?? now;
      this.waiting.set(s.id, since);
      const task = this.store.requests.list({ sessionId: s.id }).at(-1)?.createdAt ?? '';
      // Until a person sends it something (a new task, or a message that resumes it).
      if (this.count(s, STOPPED, task) > 0) continue;
      const windowStart = iso(now - WINDOW_MS);
      const tries = this.count(s, RESUMED, task > windowStart ? task : windowStart);
      if (tries >= MAX_RESUMES) {
        this.stop(s, tries);
        continue;
      }
      if (now - since < WAITS_MS[tries]!) continue;
      const attempt = `${RESUMED} try ${tries + 1} of ${MAX_RESUMES}`;
      try {
        const resumed = await this.runner.resumePaused(s.id, 'agent_exited', { reason: AUTO_RESUME_REASON });
        // Its next exit starts a new wait, from when that one is found.
        this.waiting.delete(s.id);
        if (!resumed) continue; // a person, the loop or another relaunch got there first
        this.note(s, `${attempt}: relaunched the agent ${duration(now - since)} after it was found gone.`);
      } catch (err) {
        this.waiting.set(s.id, this.options.now()); // the next try waits from this failure
        this.note(s, `${attempt} failed: ${errorMessage(err)}`);
      }
    }
  }

  /**
   * Whether resuming it is for this watcher: not a folder session (reconcile ends those), not one a
   * person took a PR of, and not one with a PR in the loop (the loop's resumeBuilder owns that one,
   * with its own count), so the two never both resume a session.
   */
  private ours(s: Session): boolean {
    if (this.store.projects.get(s.projectId)?.kind !== 'git') return false;
    const prs = this.store.pullRequests.list({ sessionId: s.id });
    return !prs.some((p) => p.outcome === null || p.outcome === 'escalated');
  }

  private stop(s: Session, tries: number): void {
    this.waiting.delete(s.id);
    this.note(
      s,
      `${STOPPED}: its agent went away again after ${tries} automatic resumes in 24 hours. It stays paused until a person sends it a message.`,
    );
    this.options.onAlert?.(
      s,
      `Session ${s.id} ("${s.title}") keeps losing its agent: it was resumed automatically ${tries} times in 24 hours and is gone again. It stays paused: send it a message to resume it, or end it.`,
    );
  }

  private recordDeath(death: TmuxServerDeath, exited: readonly Session[]): void {
    const text =
      `${TMUX_GONE} (pid ${death.pid}, started ${iso(death.startedAt)}) is gone` +
      `${death.replacedBy ? `, replaced by pid ${death.replacedBy}` : ''}. It ran for ` +
      `${duration(death.lastSeenAt - death.startedAt)} and was last seen alive at ${iso(death.lastSeenAt)}; ` +
      `found gone at ${iso(this.options.now())}, with sessions ${listIds(exited)}.`;
    this.options.log?.(`[runner] ${text}`);
    for (const projectId of new Set(exited.map((s) => s.projectId)))
      this.store.history.add({ projectId, sessionId: null, kind: 'decision', text });
  }

  private count(s: Session, prefix: string, since: string): number {
    return this.store.history.count({ sessionId: s.id, kind: 'decision', prefix, since });
  }

  private note(s: Session, text: string): void {
    this.store.history.add({ projectId: s.projectId, sessionId: s.id, kind: 'decision', text });
    this.options.log?.(`[runner] session ${s.id}: ${text}`);
  }
}
