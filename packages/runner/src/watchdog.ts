import type { Session, Store } from '@loop-engineering/core';
import { inputBoxText } from './input-box.js';
import type { SessionRunner } from './runner.js';

const MINUTE = 60_000;
/** How long a permission question may wait for the nobody who could answer it. */
const PROMPT_MS = 2 * MINUTE;
/** Idle this long before each nudge, counted from the last sign of life. */
const NUDGE_AFTER_MS = [30 * MINUTE, 120 * MINUTE, 360 * MINUTE];
/** A background shell may be what the agent waits for, or a server it forgot: not idle before this. */
const SHELL_IDLE_MS = 120 * MINUTE;
/** Between looks at git and tries to send, for a session that is past its idle limit. */
const RECHECK_MS = 5 * MINUTE;
/** Claude's spinner sits above its task list, which can be long. */
const BUSY_TAIL_LINES = 30;
const SHELL_TAIL_LINES = 8;

const tail = (pane: string, lines: number): string =>
  pane
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-lines)
    .join('\n');

// In the session's history, so counts survive a server restart: a restart can never nudge more.
const NUDGED = 'Idle watchdog nudge';
const ALERTED = 'Idle watchdog alert';

const NUDGE =
  'Automatic check: you have been idle with work that is not delivered, and nobody watches this terminal. ' +
  'Commit, merge the latest default branch, push and open the pull request. Git and network errors usually pass: ' +
  'wait and retry them. If nothing needs delivering, remove the leftover files and say so.';
const REFUSED =
  'Automatic check: a permission question waited and was refused, because nobody can approve it here. ' +
  'Find another way to do this inside your working folder.';

/** The question and what it asks about, when a pane ends in Claude's permission menu. Null otherwise. */
export function detectPermissionPrompt(pane: string): string | null {
  const lines = pane
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(-24);
  const at = lines.findLastIndex((l) => /Do you want to [^?]{1,200}\?/.test(l));
  if (at < 0) return null;
  // The menu under it: the same words in code or a summary have none.
  const menu = lines.slice(at + 1);
  const offers = (word: string) => menu.some((l) => new RegExp(`^(?:❯\\s*)?\\d+\\.\\s*${word}\\b`).test(l));
  if (!offers('Yes') || !offers('No') || !menu.some((l) => /esc to cancel/i.test(l))) return null;
  return lines.slice(Math.max(0, at - 6), at + 1).join(' ');
}

/** Claude is working: its spinner with the time so far, or the hint to interrupt it. */
export function agentBusy(pane: string): boolean {
  const end = tail(pane, BUSY_TAIL_LINES);
  return /esc to interrupt/i.test(end) || /…\s*\(\d+[hms]/.test(end);
}

/** The status under the box, or the line above it, counts running background shells. */
export function runningShell(pane: string): boolean {
  return /\b\d+ (?:background )?shells?\b(?! commands?)/i.test(tail(pane, SHELL_TAIL_LINES));
}

export interface WatchdogOptions {
  now: () => number;
  /** A session still idle with undelivered work after every nudge. Once per task. */
  onIdleAlert?: (session: Session) => void;
  log?: (message: string) => void;
}

/**
 * Nobody watches the agents' terminals, so a Claude session must not wait for a person there. A
 * permission question is refused (never approved) and an idle agent with undelivered work is told to
 * finish. Both act on what they saw on this pass and hold no lock between passes.
 */
export class SessionWatchdog {
  private readonly prompts = new Map<number, { text: string; since: number }>();
  private readonly quiet = new Map<number, { activity: number | null; since: number; looked: number }>();

  constructor(
    private readonly runner: SessionRunner,
    private readonly store: Store,
    private readonly options: WatchdogOptions,
  ) {}

  async check(session: Session): Promise<void> {
    const read = await this.runner.readClaudeAgent(session.id);
    if (!read) return;
    if (await this.refusePrompt(session, read.pane)) return;
    await this.nudgeIfIdle(session, read.pane, read.activity);
  }

  /** Drops what it remembers of sessions no longer on `ids`. */
  retain(ids: readonly number[]): void {
    for (const map of [this.prompts, this.quiet]) {
      for (const id of map.keys()) if (!ids.includes(id)) map.delete(id);
    }
  }

  /** Whether the pane shows a permission question, which leaves nothing else to do on this pass. */
  private async refusePrompt(s: Session, pane: string): Promise<boolean> {
    const text = detectPermissionPrompt(pane);
    if (!text) {
      this.prompts.delete(s.id);
      return false;
    }
    const now = this.options.now();
    const seen = this.prompts.get(s.id);
    if (!seen || seen.text !== text) {
      this.prompts.set(s.id, { text, since: now });
      return true;
    }
    if (now - seen.since < PROMPT_MS) return true;
    this.prompts.delete(s.id);
    if (!(await this.runner.refusePermissionPrompt(s.id))) return true;
    this.note(s, `Permission watchdog: refused a question nobody could answer: ${text.slice(0, 500)}`);
    await this.runner.sendToSession(s.id, REFUSED);
    return true;
  }

  private async nudgeIfIdle(s: Session, pane: string, activity: number | null): Promise<void> {
    const now = this.options.now();
    const seen = this.quiet.get(s.id);
    // Waiting at an empty box with a conversation that stopped growing: anything else is not idle.
    if (!seen || seen.activity !== activity || agentBusy(pane) || inputBoxText(pane) !== '') {
      this.quiet.set(s.id, { activity, since: now, looked: 0 });
      return;
    }
    const nudges = this.entries(s, NUDGED);
    const after = NUDGE_AFTER_MS[Math.min(nudges, NUDGE_AFTER_MS.length - 1)]!;
    const limit = runningShell(pane) ? Math.max(after, SHELL_IDLE_MS) : after;
    if (now - seen.since < limit || now - seen.looked < RECHECK_MS) return;
    seen.looked = now;
    if (!this.waitsForNobody(s) || !(await this.runner.hasUndeliveredWork(s.id))) return;
    if (nudges < NUDGE_AFTER_MS.length) {
      await this.runner.sendToSession(s.id, NUDGE);
      this.note(
        s,
        `${NUDGED} ${nudges + 1}: idle ${Math.round((now - seen.since) / MINUTE)} minutes with undelivered work.`,
      );
    } else if (this.entries(s, ALERTED) === 0) {
      this.note(s, `${ALERTED}: still idle with undelivered work after ${nudges} nudges.`);
      this.options.onIdleAlert?.(s);
    }
  }

  /** No question waits for an answer, no PR is in the loop or with the human, and this is a git project. */
  private waitsForNobody(s: Session): boolean {
    const { store } = this;
    if (store.projects.require(s.projectId).kind === 'folder') return false;
    if (store.questions.list({ sessionId: s.id, status: 'pending' }).length > 0) return false;
    return !store.pullRequests
      .list({ sessionId: s.id })
      .some((p) => p.outcome === null || p.outcome === 'escalated');
  }

  /** Entries of this kind since the session's newest task: a new task starts the count again. */
  private entries(s: Session, prefix: string): number {
    const since = this.store.requests.list({ sessionId: s.id }).at(-1)?.createdAt ?? '';
    return this.store.history
      .list({ sessionId: s.id, kind: 'decision' })
      .filter((e) => e.text.startsWith(prefix) && e.createdAt >= since).length;
  }

  private note(s: Session, text: string): void {
    this.store.history.add({ projectId: s.projectId, sessionId: s.id, kind: 'decision', text });
    this.options.log?.(`[runner] session ${s.id}: ${text}`);
  }
}
