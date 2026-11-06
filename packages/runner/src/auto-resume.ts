import { errorMessage, type Session, type Store } from '@loop-engineering/core';
import { AGENT_GONE, type SessionRunner, type TmuxServerDeath } from './runner.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/**
 * The wait before each automatic resume, by how many came before it in the window. It is counted
 * from the pass that found the agent gone and checked on each monitor pass (every 15 s), so a resume
 * comes up to one pass late, and up to two after the agent actually went: exact enough for minutes.
 */
const WAITS_MS = [1 * MINUTE, 5 * MINUTE, 15 * MINUTE];
const MAX_RESUMES = WAITS_MS.length;
/** Automatic resumes are counted over this rolling window (and since the person's newest message). */
const WINDOW_MS = 24 * HOUR;
/**
 * Only a session whose agent reconcile found gone this recently is resumed: one that was left
 * paused long ago (before a deploy, or by a person who saw it) is not woken.
 */
const GONE_WITHIN_MS = 3 * HOUR;
/** Agents found gone in a pass that came this soon after the one before went at once. */
const PASS_GAP_MS = 5 * MINUTE;

// In the session's history, so counts survive a server restart. A failed try counts like one that
// worked: a launch that keeps failing must reach the owner too.
const RESUMED = 'Auto-resume:';
const STOPPED = 'Auto-resume stopped';
const TMUX_GONE = 'The tmux server';

/** Why the agent is resumed, for its first prompt ("Resumed: <this>. Continue where you left off."). */
export const AUTO_RESUME_REASON =
  'your agent process exited or its terminal closed, and nothing in your task asked for that. Your worktree is ' +
  'intact. A background command you had running may have died or may still be running, and its log may end ' +
  'early, so do not trust a partial log: check with ps, the ports it used and its log, rerun only what no longer ' +
  'runs, and never start a second copy. Then carry on with your task';

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

/** "Session 4" or "Sessions 4 and 7". */
const sessionsLabel = (sessions: readonly Session[]) =>
  `${sessions.length === 1 ? 'Session' : 'Sessions'} ${listIds(sessions)}`;

/** The singular or the plural form, by how many sessions. */
const verb = (sessions: readonly Session[], one: string, many: string) =>
  sessions.length === 1 ? one : many;

/** What happens next to a session whose agent went: see afterReconcile's alert. */
type Fate = 'resumed' | 'loop' | 'paused' | 'spent' | 'ended';

/** An error in an alert is cut to this: a tmux error repeats the whole command line, a git one can be longer. */
const ERROR_CHARS = 300;
/** An alert is cut to this: ask_human refuses a question over 3000 characters, and the alert would be lost. */
const ALERT_CHARS = 2_500;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** A session the owner hears about after a pass: alone, or as one line among others of the same pass. */
interface Trouble {
  session: Session;
  alone: string;
  line: string;
}

/**
 * Nobody watches the agents' terminals, so a session whose agent went away by itself (paused as
 * agent_exited by reconcile: a crash, a closed window, the tmux server dying) is resumed after a
 * short wait, at most MAX_RESUMES times in WINDOW_MS, then the owner hears once. A session with a
 * PR in the loop is the loop's: it resumes its builder when the PR needs it (the feedback goes in
 * its first prompt). A pause someone chose replaces agent_exited (runner.pause), so it stands.
 */
export class AutoResume {
  /** Sessions waiting to be resumed: since when (first seen, or the last failed try), and how long its conversation was then. */
  private readonly waiting = new Map<number, { since: number; size: number | null }>();
  private lastPass: number | undefined;

  constructor(
    private readonly runner: SessionRunner,
    private readonly store: Store,
    private readonly options: AutoResumeOptions,
  ) {}

  /**
   * After the pass's reconcile found the windows of `vanished` gone (not a dead pane: closed from
   * outside, or with the tmux server): records a tmux server that died holding them, and tells
   * the owner once when several went at once, or the server with them.
   */
  async afterReconcile(vanished: readonly Session[]): Promise<void> {
    const now = this.options.now();
    // The first pass after a start, or after a long stall, can't tell whether windows went together.
    const atOnce = this.lastPass !== undefined && now - this.lastPass <= PASS_GAP_MS;
    this.lastPass = now;
    const death = await this.runner.checkTmuxServer(vanished.length > 0, now);
    if (death) this.recordDeath(death, vanished);
    // A dead server says they went together, also on the first pass after a start. It is reported
    // once: checkTmuxServer saves the new server first, and these sessions are no longer active.
    if (vanished.length === 0 || (!death && !(atOnce && vanished.length >= 2))) return;
    const what = death
      ? `${sessionsLabel(vanished)} lost ${verb(vanished, 'its agent', 'their agents')} when the tmux server ` +
        `holding ${verb(vanished, 'it', 'them')} (pid ${death.pid}) died: it ran for ` +
        `${duration(death.lastSeenAt - death.startedAt)} and was last seen alive at ${iso(death.lastSeenAt)}.`
      : `${sessionsLabel(vanished)} lost their agents at once.`;
    const { text, resumed } = this.fates(vanished, now);
    const message = `${what} ${text}${resumed ? ' You hear again only if resuming stops working.' : ''}`;
    this.options.log?.(`[runner] ${message}`);
    this.alert(vanished.find((s) => s.status !== 'ended') ?? vanished[0]!, message);
  }

  /**
   * What happens to each of `sessions` now, by the rules run() and the loop follow, in sentences;
   * `resumed` when any of them is resumed automatically.
   */
  private fates(sessions: readonly Session[], now: number): { text: string; resumed: boolean } {
    const human = this.store.requests.latestBySession();
    const by = new Map<Fate, Session[]>();
    for (const s of sessions) {
      const fate = this.fate(s, human.get(s.id) ?? '', now);
      by.set(fate, [...(by.get(fate) ?? []), s]);
    }
    const say: Record<Fate, (group: Session[]) => string> = {
      resumed: (g) =>
        `${verb(g, 'is', 'are')} resumed automatically, at most ${MAX_RESUMES} times in 24 hours`,
      loop: (g) =>
        `${verb(g, 'has a PR', 'have PRs')} in the loop, which resumes ` +
        `${verb(g, 'it when the PR needs it', 'each when its PR needs it')}`,
      paused: (g) =>
        `${verb(g, 'stays paused: its PR was', 'stay paused: their PRs were')} sent to you or taken over, or ` +
        'finished since your last message',
      spent: (g) =>
        `${verb(g, 'has used its', 'have used their')} ${MAX_RESUMES} automatic resumes in 24 hours and ` +
        `${verb(g, 'stays', 'stay')} paused until you send ${verb(g, 'it', 'each')} a message`,
      ended: (g) => `${verb(g, 'was', 'were')} ended: a folder session is not resumed`,
    };
    const groups = (['resumed', 'spent', 'loop', 'paused', 'ended'] as const).filter((f) => by.has(f));
    const text = groups
      .map((f) => {
        const group = by.get(f)!;
        // One group needs no names again; several say whose is whose.
        const who = groups.length === 1 ? verb(group, 'It', 'They') : sessionsLabel(group);
        return `${who} ${say[f](group)}.`;
      })
      .join(' ');
    return { text, resumed: by.has('resumed') };
  }

  private fate(s: Session, task: string, now: number): Fate {
    if (s.status === 'ended') return 'ended';
    if (this.ours(s, task)) {
      // What run() does with it in this same pass: no resume is left, so it stops.
      const spent = this.count(s, STOPPED, task) > 0 || this.tries(s, task, now) >= MAX_RESUMES;
      return spent ? 'spent' : 'resumed';
    }
    const inLoop = this.store.pullRequests.list({ sessionId: s.id }).some((p) => p.outcome === null);
    return inLoop ? 'loop' : 'paused';
  }

  /** Automatic resumes of `s` in the last 24 hours, since the person's newest message `task`. */
  private tries(s: Session, task: string, now: number): number {
    const windowStart = iso(now - WINDOW_MS);
    return this.count(s, RESUMED, task > windowStart ? task : windowStart);
  }

  /**
   * Resumes the sessions that are due. `skip`: sessions another part of the monitor is relaunching.
   * Failed tries, and sessions out of resumes, each reach the owner as one alert per pass: sessions
   * lost together are tried together, and a dozen of them must not become dozens of questions.
   */
  async run(skip: ReadonlySet<number> = new Set()): Promise<void> {
    const failed: Trouble[] = [];
    const stopped: Trouble[] = [];
    try {
      await this.resumeDue(skip, failed, stopped);
    } finally {
      this.alertTogether(
        failed,
        (g) => `${sessionsLabel(g)} lost their agents, and an automatic resume of each failed.`,
        'You hear again about a session when its resumes run out, whether they fail or its agent keeps going away.',
      );
      this.alertTogether(
        stopped,
        (g) => `${sessionsLabel(g)} stay paused, out of automatic resumes.`,
        'Send a session a message to resume it, or end it.',
      );
    }
  }

  private async resumeDue(skip: ReadonlySet<number>, failed: Trouble[], stopped: Trouble[]): Promise<void> {
    const now = this.options.now();
    // A person's newest message: the loop's own "[loop]" requests don't count.
    const human = this.store.requests.latestBySession();
    const exited = this.store.sessions
      .list({ status: 'paused' })
      .filter(
        (s) =>
          s.pauseReason === 'agent_exited' &&
          !skip.has(s.id) &&
          this.ours(s, human.get(s.id) ?? '') &&
          this.count(s, AGENT_GONE, iso(now - GONE_WITHIN_MS)) > 0,
      );
    for (const id of this.waiting.keys()) if (!exited.some((s) => s.id === id)) this.waiting.delete(id);
    for (const s of exited) {
      let seen = this.waiting.get(s.id);
      if (!seen) {
        seen = { since: now, size: await this.runner.conversationSize(s.id) };
        this.waiting.set(s.id, seen);
      }
      const task = human.get(s.id) ?? '';
      if (this.count(s, STOPPED, task) > 0) continue; // until a person sends it a message
      const tries = this.tries(s, task, now);
      if (tries >= MAX_RESUMES) {
        stopped.push(this.stop(s, tries));
        continue;
      }
      if (now - seen.since < WAITS_MS[tries]!) continue;
      // tmux briefly unreachable looks like every window gone: an agent still writing its
      // conversation runs somewhere, and a second one in the same worktree would fight it.
      const size = await this.runner.conversationSize(s.id);
      if (size !== null && seen.size !== null && size > seen.size) {
        this.options.log?.(
          `[runner] session ${s.id}: not resumed, its conversation is still growing (an agent may still run)`,
        );
        this.waiting.set(s.id, { since: now, size });
        continue;
      }
      const attempt = `${RESUMED} try ${tries + 1} of ${MAX_RESUMES}`;
      try {
        const resumed = await this.runner.resumePaused(s.id, 'agent_exited', { reason: AUTO_RESUME_REASON });
        // Its next exit starts a new wait, from when that one is found.
        this.waiting.delete(s.id);
        if (!resumed) continue; // a person, the loop or another relaunch got there first
        this.note(
          s,
          `${attempt}: relaunched the agent ${duration(now - seen.since)} after it was found gone.`,
        );
      } catch (err) {
        const why = errorMessage(err);
        this.note(s, `${attempt} failed: ${why}`);
        if (tries + 1 >= MAX_RESUMES) {
          stopped.push(this.stop(s, tries + 1, why));
          continue;
        }
        this.waiting.set(s.id, { since: this.options.now(), size }); // the next try waits from this failure
        const failure = `try ${tries + 1} of ${MAX_RESUMES} failed: ${clip(why, ERROR_CHARS)}`;
        const next = duration(WAITS_MS[tries + 1]!);
        failed.push({
          session: s,
          alone:
            `Session ${s.id} ("${s.title}") lost its agent, and automatic resume ${failure}. It is tried again in ` +
            `${next}. You hear again when its resumes run out, whether they fail or its agent keeps going away.`,
          line: `Session ${s.id} ("${s.title}"): ${failure}; tried again in ${next}.`,
        });
      }
    }
  }

  /**
   * Whether resuming it is for this watcher: a git session (reconcile ends folder ones) none of
   * whose PRs is in the loop (the loop's resumeBuilder owns that one, with its own count, so the two
   * never both resume a session), taken over by a person, or finished (merged, closed, reverted)
   * since the person's newest message: the work it was resumed for is done or was stopped.
   */
  private ours(s: Session, task: string): boolean {
    if (this.store.projects.get(s.projectId)?.kind !== 'git') return false;
    return !this.store.pullRequests
      .list({ sessionId: s.id })
      .some((p) => p.outcome === null || p.outcome === 'escalated' || p.updatedAt >= task);
  }

  /**
   * No automatic resume is left: `failure` when the last one failed, else the agent went again.
   * Recorded now; run() tells the owner, with the others of the same pass.
   */
  private stop(s: Session, tries: number, failure?: string): Trouble {
    this.waiting.delete(s.id);
    const after = `${tries} automatic resumes in 24 hours`;
    this.note(
      s,
      `${STOPPED}: ${failure ? `the last of ${after} failed (${failure})` : `its agent went away again after ${after}`}. It stays paused until a person sends it a message.`,
    );
    const why = failure && clip(failure, ERROR_CHARS);
    return {
      session: s,
      alone: why
        ? `Session ${s.id} ("${s.title}") lost its agent, and the last of ${after} failed: ${why}. It stays paused: send it a message to resume it, or end it.`
        : `Session ${s.id} ("${s.title}") keeps losing its agent: it was resumed automatically ${tries} times in 24 hours and is gone again. It stays paused: send it a message to resume it, or end it.`,
      line: why
        ? `Session ${s.id} ("${s.title}"): the last of ${after} failed: ${why}.`
        : `Session ${s.id} ("${s.title}"): resumed automatically ${tries} times in 24 hours and gone again.`,
    };
  }

  /** One alert for the troubles of a pass: a single one as it is, several under `head` and over `tail`. */
  private alertTogether(troubles: Trouble[], head: (sessions: Session[]) => string, tail: string): void {
    const sorted = [...troubles].sort((a, b) => a.session.id - b.session.id);
    const [first] = sorted;
    if (!first) return;
    const message =
      sorted.length === 1
        ? first.alone
        : `${head(sorted.map((t) => t.session))} ${sorted.map((t) => t.line).join(' ')} ${tail}`;
    this.alert(first.session, message);
  }

  private alert(s: Session, message: string): void {
    this.options.onAlert?.(s, clip(message, ALERT_CHARS));
  }

  private recordDeath(death: TmuxServerDeath, vanished: readonly Session[]): void {
    const text =
      `${TMUX_GONE} (pid ${death.pid}, started ${iso(death.startedAt)}) is gone` +
      `${death.replacedBy ? `, replaced by pid ${death.replacedBy}` : ''}. It ran for ` +
      `${duration(death.lastSeenAt - death.startedAt)} and was last seen alive at ${iso(death.lastSeenAt)}; ` +
      `found gone at ${iso(this.options.now())}, with sessions ${listIds(vanished)}.`;
    this.options.log?.(`[runner] ${text}`);
    for (const projectId of new Set(vanished.map((s) => s.projectId)))
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
