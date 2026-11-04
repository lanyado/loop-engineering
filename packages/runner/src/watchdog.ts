import type { PullRequest, Session, Store } from '@loop-engineering/core';
import { inputBoxHolds, inputBoxText } from './input-box.js';
import type { SessionRunner } from './runner.js';
import { detectTrustPrompt } from './trust-prompt.js';

const MINUTE = 60_000;
/** How long a permission question may wait for the nobody who could answer it. */
const PROMPT_MS = 2 * MINUTE;
/** Idle this long before each nudge, counted from the last sign of life. */
const NUDGE_AFTER_MS = [30 * MINUTE, 120 * MINUTE, 360 * MINUTE];
/**
 * A background shell may be what the agent waits for, so it counts as idle only after this. It can
 * also be a run that hung, or a server the agent forgot, so it never mutes the session.
 */
const SHELL_IDLE_MS = 45 * MINUTE;
/** A screen that is no input box, up this long with a silent conversation, is for a person to see. */
const STUCK_SCREEN_MS = 60 * MINUTE;
/** The agent hears why this many times per task. Each telling is a paid turn, and it may just try again. */
const MAX_EXPLAINED_REFUSALS = 3;
/** Between looks at git and tries to send, for a session that is past its idle limit. */
const RECHECK_MS = 5 * MINUTE;
/** Claude's spinner sits above its task list, which can be long. */
const BUSY_TAIL_LINES = 30;
const SHELL_TAIL_LINES = 8;
/** A dialog can be long, and what it asks about can sit well above its menu. */
const MENU_TAIL_LINES = 40;
const PROMPT_CONTEXT_LINES = 12;

const tail = (pane: string, lines: number): string =>
  pane
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-lines)
    .join('\n');

// In the session's history, so counts survive a server restart: a restart can never nudge more.
const NUDGED = 'Idle watchdog nudge';
const ALERTED = 'Idle watchdog alert';
const REFUSAL = 'Permission watchdog: refused';
const REFUSAL_ALERTED = 'Permission watchdog alert';
const STUCK_ALERTED = 'Screen watchdog alert';

const NUDGE =
  'Automatic check: you have been idle with work that is not delivered, and nobody watches this terminal. ' +
  'Commit what belongs to your task, merge the latest default branch, push and open the pull request. Git and ' +
  'network errors usually pass: wait and retry them. Do not delete files you did not create: if something does ' +
  'not belong to the task, leave it and say so.';
const FIX =
  'Automatic check: your pull request is waiting for your answer to the feedback you were sent, you have been idle, ' +
  'and nobody watches this terminal. Fix what it asks, commit and push. Git and network errors usually pass: wait ' +
  'and retry them. Do not delete files you did not create.';
const HUNG =
  'Automatic check: you have been waiting at your prompt with a background run for a long time, and nobody watches ' +
  'this terminal. It may have hung. Check its output, stop runs you started that have hung, rerun them under ' +
  '`timeout`, and continue with your task.';
const REFUSED =
  'Automatic check: a permission question waited and was refused, because nobody can approve it here. ' +
  'Find another way to do this inside your working folder.';

/** Claude's spinner with the time so far, or the hint to interrupt it. A tool's own "⎿ Running… (2m)" is not it. */
const WORKING = /esc to interrupt|^\s*[^\s\w⎿]\s+\S.*…\s*\(\d+[hms]/im;

const CHOICE = /^(?:[❯›>]\s*)?\d+\.\s/;
const SELECTED = /^[❯›>]\s*\d+\.\s/;
/** A choice can wrap in a narrow pane. */
const MAX_WRAPPED_LINES = 3;

/**
 * The question and what it asks about, when the pane ends in one of Claude's permission menus: a
 * question, a numbered menu with one selected, the "Esc to cancel" footer at the very bottom and no
 * input box. The wording differs by tool and mode, so the shape decides. A menu quoted in a summary
 * has the box or the spinner under it. The folder-trust dialog has its own handling.
 */
export function detectPermissionPrompt(pane: string): string | null {
  if (inputBoxText(pane) !== null || detectTrustPrompt(pane)) return null;
  const lines = pane
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(-MENU_TAIL_LINES);
  const footer = lines.findLastIndex((l) => /\besc to (?:cancel|exit)\b/i.test(l));
  // One line may follow it: the session title Claude can draw at the right.
  if (footer < 0 || footer < lines.length - 2 || WORKING.test(lines[footer + 1] ?? '')) return null;
  let last = footer - 1;
  while (last >= 0 && footer - last <= MAX_WRAPPED_LINES && !CHOICE.test(lines[last]!)) last--;
  if (last < 0 || !CHOICE.test(lines[last]!)) return null;
  let first = last;
  for (let i = first - 1; i >= 0 && first - i <= MAX_WRAPPED_LINES; i--)
    if (CHOICE.test(lines[i]!)) first = i;
  const menu = lines.slice(first, last + 1);
  if (first === 0 || menu.filter((l) => CHOICE.test(l)).length < 2 || !menu.some((l) => SELECTED.test(l)))
    return null;
  if (!lines[first - 1]!.endsWith('?')) return null;
  return lines.slice(Math.max(0, first - PROMPT_CONTEXT_LINES), first).join(' ');
}

/** Claude is working: its spinner with the time so far, or the hint to interrupt it. */
export function agentBusy(pane: string): boolean {
  return WORKING.test(tail(pane, BUSY_TAIL_LINES));
}

/** The status under the box, or the line above it, counts running background shells. */
export function runningShell(pane: string): boolean {
  return /\b\d+ (?:background )?shells?\b(?! commands?)/i.test(tail(pane, SHELL_TAIL_LINES));
}

/** An idle agent's box can take `message`: it is empty, or holds that message from a send that timed out. */
function canTake(pane: string, message: string): boolean {
  return !agentBusy(pane) && (inputBoxText(pane) === '' || inputBoxHolds(pane, message));
}

/**
 * Feedback reached the builder, and no push has answered it: the loop drops it on the next push, and
 * runs no job for the PR meanwhile. A PR with the human has had its feedback dropped when it got there.
 */
function owesAnswer(pr: PullRequest): boolean {
  const feedback = pr.loopState.feedback as { sentAt?: unknown } | undefined;
  return pr.outcome === null && pr.stage !== 'escalated' && !!feedback?.sentAt;
}

export interface WatchdogOptions {
  now: () => number;
  /** Reminders or refusals did not help, and a person should look. Once per kind and task. */
  onAlert?: (session: Session, message: string) => void;
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
  /** Sessions whose agent was refused and has not yet heard why, because sending failed. */
  private readonly owedExplanation = new Set<number>();
  private readonly screens = new Map<number, { activity: number | null; since: number }>();

  constructor(
    private readonly runner: SessionRunner,
    private readonly store: Store,
    private readonly options: WatchdogOptions,
  ) {}

  async check(session: Session): Promise<void> {
    const read = await this.runner.readClaudeAgent(session.id);
    if (!read) return;
    this.alertIfStuck(session, read.pane, read.activity);
    if (await this.refusePrompt(session, read.pane)) return;
    // A box with other text in it can't take the explanation: the reminders below still apply.
    if (this.owedExplanation.has(session.id) && canTake(read.pane, REFUSED)) {
      await this.explainRefusal(session);
      return;
    }
    await this.nudgeIfIdle(session, read.pane, read.activity);
  }

  /** Drops what it remembers of sessions no longer on `ids`. */
  retain(ids: readonly number[]): void {
    for (const known of [this.prompts, this.quiet, this.owedExplanation, this.screens]) {
      for (const id of known.keys()) if (!ids.includes(id)) known.delete(id);
    }
  }

  /** The safety net for a dialog nothing here knows: it never presses anything, only tells a person. */
  private alertIfStuck(s: Session, pane: string, activity: number | null): void {
    const now = this.options.now();
    const seen = this.screens.get(s.id);
    if (inputBoxText(pane) !== null || detectTrustPrompt(pane)) {
      this.screens.delete(s.id);
    } else if (!seen || seen.activity !== activity) {
      this.screens.set(s.id, { activity, since: now });
    } else if (now - seen.since >= STUCK_SCREEN_MS && this.entries(s, STUCK_ALERTED) === 0) {
      this.note(
        s,
        `${STUCK_ALERTED}: the screen has shown no input box for an hour: ${tail(pane, 6).slice(-500)}`,
      );
      this.options.onAlert?.(
        s,
        `Session ${s.id} ("${s.title}") has shown a screen with no input box for an hour, and nothing here can answer it. See its history for what it shows.`,
      );
    }
  }

  /** Whether the pane shows a permission question, which leaves nothing else to do on this pass. */
  private async refusePrompt(s: Session, pane: string): Promise<boolean> {
    const text = detectPermissionPrompt(pane);
    // A person took over this session's PR, and may be the one answering at this terminal.
    if (!text || this.prs(s).some((p) => p.outcome === 'escalated')) {
      this.prompts.delete(s.id);
      return text !== null;
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
    const earlier = this.entries(s, REFUSAL);
    this.note(s, `${REFUSAL} a question nobody could answer: ${text.slice(-900)}`);
    if (earlier < MAX_EXPLAINED_REFUSALS) {
      this.owedExplanation.add(s.id);
      await this.explainRefusal(s);
    } else if (this.entries(s, REFUSAL_ALERTED) === 0) {
      this.note(
        s,
        `${REFUSAL_ALERTED}: the agent keeps asking after ${earlier} refusals, and hears no more.`,
      );
      this.options.onAlert?.(
        s,
        `Session ${s.id} ("${s.title}") keeps asking for a permission nobody can give: it was refused ${earlier + 1} times. See its history for what it asks.`,
      );
    }
    return true;
  }

  /** Until this works, the agent may sit waiting with no idea why. */
  private async explainRefusal(s: Session): Promise<void> {
    await this.runner.sendToSession(s.id, REFUSED);
    this.owedExplanation.delete(s.id);
  }

  private async nudgeIfIdle(s: Session, pane: string, activity: number | null): Promise<void> {
    const now = this.options.now();
    const seen = this.quiet.get(s.id);
    // Waiting at an empty box with a conversation that stopped growing: anything else is not idle. A
    // text of ours left in the box when sending timed out counts as empty: the next send finishes it.
    if (!seen || seen.activity !== activity || ![NUDGE, FIX, HUNG].some((m) => canTake(pane, m))) {
      this.quiet.set(s.id, { activity, since: now, looked: 0 });
      return;
    }
    const nudges = this.entries(s, NUDGED);
    const after = NUDGE_AFTER_MS[Math.min(nudges, NUDGE_AFTER_MS.length - 1)]!;
    const shell = runningShell(pane);
    const limit = shell ? Math.max(after, SHELL_IDLE_MS) : after;
    if (now - seen.since < limit || now - seen.looked < RECHECK_MS) return;
    seen.looked = now;
    const turn = this.agentsTurn(s);
    if (!turn || (turn === 'deliver' && !(await this.runner.hasUndeliveredWork(s.id)))) return;
    if (nudges < NUDGE_AFTER_MS.length) {
      await this.runner.sendToSession(s.id, shell ? HUNG : turn === 'fix' ? FIX : NUDGE);
      this.note(
        s,
        `${NUDGED} ${nudges + 1}: idle ${Math.round((now - seen.since) / MINUTE)} minutes, ${turn === 'fix' ? 'owing an answer to PR feedback' : 'with undelivered work'}.`,
      );
    } else if (this.entries(s, ALERTED) === 0) {
      this.note(s, `${ALERTED}: still idle with undelivered work after ${nudges} nudges.`);
      this.options.onAlert?.(
        s,
        `Session ${s.id} ("${s.title}") is idle with work that is not delivered, and ${nudges} automatic reminders did not help. Open it to see why.`,
      );
    }
  }

  /**
   * Whether the next move is this agent's: to deliver, with no PR yet, or to fix, with a PR waiting
   * for its answer to feedback. Null while a question waits for a person, a person has a PR of the
   * session, or a PR waits for the loop's own jobs. Folder projects deliver nothing.
   */
  private agentsTurn(s: Session): 'deliver' | 'fix' | null {
    const { store } = this;
    if (store.projects.require(s.projectId).kind === 'folder') return null;
    if (store.questions.list({ sessionId: s.id, status: 'pending' }).length > 0) return null;
    const prs = this.prs(s);
    if (prs.some((p) => p.outcome === 'escalated')) return null;
    if (prs.some(owesAnswer)) return 'fix';
    return prs.some((p) => p.outcome === null) ? null : 'deliver';
  }

  private prs(s: Session) {
    return this.store.pullRequests.list({ sessionId: s.id });
  }

  /** Entries of this kind since the session's newest task: a new task starts the count again. */
  private entries(s: Session, prefix: string): number {
    const since = this.store.requests.list({ sessionId: s.id }).at(-1)?.createdAt ?? '';
    return this.store.history.count({ sessionId: s.id, kind: 'decision', prefix, since });
  }

  private note(s: Session, text: string): void {
    this.store.history.add({ projectId: s.projectId, sessionId: s.id, kind: 'decision', text });
    this.options.log?.(`[runner] session ${s.id}: ${text}`);
  }
}
