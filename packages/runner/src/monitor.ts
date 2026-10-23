import type { Session, Store } from '@loop-engineering/core';
import type { SessionRunner } from './runner.js';
import { DEFAULT_TAIL_LINES, USAGE_LIMIT_PATTERNS } from './usage-limit.js';

export interface MonitorOptions {
  /** Poll interval. Default 15 s. */
  intervalMs?: number;
  /** Default USAGE_LIMIT_PATTERNS; pass an extended list to catch new wordings. */
  patterns?: readonly RegExp[];
  /** Non-empty lines at the bottom of the pane that are checked. */
  tailLines?: number;
  onFallback?: (session: Session) => void;
  /** A session whose agent was found gone and was paused (agent_exited). */
  onAgentExited?: (session: Session) => void;
  onError?: (error: unknown, sessionId: number | null) => void;
  /** An OpenCode session moved to the next model (limit, error or hang); `why` says which. */
  onModelRotated?: (session: Session, why: string) => void;
  /** A busy OpenCode agent whose screen has not changed this long is hung. Default 30 minutes. */
  stallMs?: number;
  /**
   * Sessions paused at Claude's usage limit are resumed on Claude this often; if the limit still holds,
   * the next pass pauses them again. Default: never (nothing resumes them).
   */
  retryClaudeLimitMs?: number;
  /** A session resumed after waiting out Claude's usage limit. */
  onLimitResumed?: (session: Session) => void;
  now?: () => number;
  /**
   * A Claude session stuck at the folder-trust dialog in `folder`. Called once per agent launch
   * (session id + tmux window), not on every pass.
   */
  onTrustPrompt?: (session: Session, folder: string) => void;
}

export interface MonitorPass {
  /** Sessions switched to OpenCode. */
  switched: Session[];
  /** Sessions paused because their agent was gone. */
  exited: Session[];
  /** Sessions newly found waiting at Claude's folder-trust dialog. */
  trustWaits: Session[];
  /** OpenCode sessions moved to the next model. */
  rotated: Session[];
}

/**
 * Lines OpenCode shows when the model cannot answer (limits, quota, outages). Only read once the
 * agent has stopped, and only near the bottom, so code or text the agent is reading never counts.
 */
export const OPENCODE_MODEL_ERRORS: readonly RegExp[] = [
  /rate.?limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota/i,
  /overloaded/i,
  /insufficient (balance|credits?)/i,
  /model.{0,40}not (found|available|supported)/i,
  /provider.{0,20}(error|unavailable)/i,
];

const MAX_ROTATIONS_PER_HOUR = 5;
/** An error line says so; a summary that mentions rate limits does not read like this. */
const ERROR_WORDING = /\b(error|failed|exceeded|reached|unavailable|denied)\b|\b429\b/i;

/** The screen without spinners and progress bars, so an agent that only animates counts as unchanged. */
export function stillScreen(pane: string): string {
  return pane
    .replace(/[\u2800-\u28ff■⬝▀▄█░▒▓]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Each pass first reconciles sessions against tmux (dead agents become paused), then has the runner
 * check every active local Claude session's pane for the folder-trust dialog and for a usage-limit
 * message.
 */
export class UsageLimitMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** `<session id> <tmux target>` of agents already reported at the trust dialog. */
  private readonly trustReported = new Set<string>();

  constructor(
    private readonly runner: SessionRunner,
    private readonly store: Store,
    private readonly options: MonitorOptions = {},
  ) {}

  async checkOnce(): Promise<MonitorPass> {
    const pass: MonitorPass = { switched: [], exited: [], trustWaits: [], rotated: [] };
    try {
      pass.exited = await this.runner.reconcile();
      for (const s of pass.exited) this.options.onAgentExited?.(s);
    } catch (err) {
      this.options.onError?.(err, null);
    }
    const check = {
      patterns: this.options.patterns ?? USAGE_LIMIT_PATTERNS,
      tailLines: this.options.tailLines ?? DEFAULT_TAIL_LINES,
    };
    const sessions = this.store.sessions
      .list({ status: 'active' })
      .filter((s) => s.provider === 'claude' && s.tmuxTarget !== null);
    for (const s of sessions) {
      try {
        const waiting = await this.runner.checkTrustPrompt(s.id);
        if (waiting) {
          const key = `${s.id} ${String(waiting.session.tmuxTarget)}`;
          if (!this.trustReported.has(key)) {
            this.trustReported.add(key);
            pass.trustWaits.push(waiting.session);
            this.options.onTrustPrompt?.(waiting.session, waiting.folder);
          }
          continue; // a pane showing the dialog has no usage-limit message to act on
        }
        const switched = await this.runner.checkUsageLimit(s.id, check);
        if (switched) {
          pass.switched.push(switched);
          this.options.onFallback?.(switched);
        }
      } catch (err) {
        this.options.onError?.(err, s.id);
      }
    }
    await this.checkOpencode(pass);
    await this.retryClaudeLimit();
    return pass;
  }

  /** `<session id>` -> when it was last tried (or first seen) while paused at Claude's usage limit. */
  private readonly limitTries = new Map<number, number>();

  /** Resumes sessions waiting out Claude's usage limit, once per retryClaudeLimitMs each. */
  private async retryClaudeLimit(): Promise<void> {
    const every = this.options.retryClaudeLimitMs;
    if (!every) return;
    const now = (this.options.now ?? Date.now)();
    const waiting = this.store.sessions
      .list({ status: 'paused' })
      .filter((s) => s.pauseReason === 'usage_limit' && s.provider === 'claude');
    for (const id of this.limitTries.keys())
      if (!waiting.some((s) => s.id === id)) this.limitTries.delete(id);
    for (const s of waiting) {
      const last = this.limitTries.get(s.id);
      if (last === undefined) {
        this.limitTries.set(s.id, now);
        continue;
      }
      if (now - last < every) continue;
      this.limitTries.set(s.id, now);
      try {
        const resumed = await this.runner.resume(s.id, {
          ifReason: 'usage_limit',
          reason: 'Claude usage limit should have reset',
        });
        if (resumed.status === 'active') this.options.onLimitResumed?.(resumed);
      } catch (err) {
        this.options.onError?.(err, s.id);
      }
    }
  }

  /** Sessions moved to another model whose relaunch has not worked yet. */
  private readonly relaunch = new Set<number>();
  /** `<session id> <model> <error line>` already acted on (the same message from the next model counts). */
  private readonly handledErrors = new Set<string>();
  /** `<session id>` -> when it was last moved to another model. */
  private readonly rotations = new Map<number, number[]>();
  /** `<session id>` -> the agent's still screen and when it was first seen like that. */
  private readonly screens = new Map<number, { key: string; since: number }>();

  /** Moves an OpenCode session to the next model when its model errors out or its agent hangs. */
  private async checkOpencode(pass: MonitorPass): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    const stallMs = this.options.stallMs ?? 30 * 60_000;
    const sessions = this.store.sessions
      .list({ status: 'active' })
      .filter((s) => s.provider === 'opencode' && s.tmuxTarget !== null);
    for (const id of this.screens.keys()) if (!sessions.some((s) => s.id === id)) this.screens.delete(id);
    for (const id of [...this.relaunch]) {
      const s = this.store.sessions.get(id);
      if (!s || s.status !== 'paused' || s.pauseReason !== 'agent_exited') {
        this.relaunch.delete(id);
        continue;
      }
      try {
        await this.runner.resume(id, {
          ifReason: 'agent_exited',
          reason: 'the relaunch on a new model failed before',
          fresh: true,
        });
        this.relaunch.delete(id);
      } catch (err) {
        this.options.onError?.(err, id);
      }
    }
    for (const s of sessions) {
      try {
        const read = await this.runner.readOpencodePane(s.id);
        if (!read) continue;
        const key = `${String(read.session.tmuxTarget)} ${stillScreen(read.pane)}`;
        const seen = this.screens.get(s.id);
        if (!seen || seen.key !== key) this.screens.set(s.id, { key, since: now });
        let why: string | null = null;
        if (!read.busy) {
          // Only a line that reads as an error, and only one not acted on before: a finished agent's
          // summary or file list (or the old error, redrawn after a relaunch) must never count.
          const line = read.pane
            .split('\n')
            .filter((l) => l.trim())
            .slice(-12)
            .map((l) => l.trim())
            .find(
              (l) =>
                ERROR_WORDING.test(l) &&
                OPENCODE_MODEL_ERRORS.some((p) => p.test(l)) &&
                !this.handledErrors.has(`${s.id} ${s.model} ${l}`),
            );
          if (line) {
            this.handledErrors.add(`${s.id} ${s.model} ${line}`);
            why = `stopped with a model error (${line.slice(0, 160)})`;
          }
        } else if (seen && seen.key === key && now - seen.since >= stallMs) {
          why = `showed no progress for ${Math.round((now - seen.since) / 60_000)} minutes`;
        }
        if (!why) continue;
        this.screens.delete(s.id);
        // Every model failing in a row (or a false alarm repeating) must not cycle all night.
        const recent = (this.rotations.get(s.id) ?? []).filter((t) => now - t < 60 * 60_000);
        if (recent.length >= MAX_ROTATIONS_PER_HOUR) continue;
        this.rotations.set(s.id, [...recent, now]);
        this.relaunch.add(s.id); // until the relaunch has worked: retried on every pass
        const moved = await this.runner.rotateModel(s.id, why);
        this.relaunch.delete(s.id);
        pass.rotated.push(moved);
        this.options.onModelRotated?.(moved, why);
      } catch (err) {
        this.options.onError?.(err, s.id);
      }
    }
  }

  /** Runs a pass now (startup reconcile) and then every intervalMs. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 15_000);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return; // a slow pass (a relaunch) must not overlap the next one
    this.running = true;
    try {
      await this.checkOnce();
    } finally {
      this.running = false;
    }
  }
}
