import type { Clock } from '@loop-engineering/core';

export interface AccessControlOptions {
  ownerId: number;
  /** Reads the dashboard-managed allowlist (core Settings.telegramAllowlist). */
  allowlist: () => number[];
  clock: Clock;
  log: (message: string) => void;
  /** Per-user quiet period between "ignored" log lines. Default 10 minutes. */
  logWindowMs?: number;
  /** Most "ignored" log lines per window across all users. Default 20. */
  maxLogsPerWindow?: number;
}

/**
 * Who may talk to the bot: the owner (TELEGRAM_OWNER_ID) and the allowlist from Settings. The
 * allowlist is read from SQLite on every check rather than cached, so a dashboard edit applies to
 * the very next update with no change notification needed (it is a one-row primary-key read).
 * Everyone else is ignored without a reply; logging about them is rate limited so a stranger
 * spamming the bot cannot flood the server log.
 */
export class AccessControl {
  private readonly windowMs: number;
  private readonly maxLogs: number;
  private readonly lastLogged = new Map<number, number>();
  private windowStart = 0;
  private logsInWindow = 0;
  private suppressed = 0;

  constructor(private readonly options: AccessControlOptions) {
    this.windowMs = options.logWindowMs ?? 10 * 60_000;
    this.maxLogs = options.maxLogsPerWindow ?? 20;
  }

  isAllowed(userId: number | undefined): boolean {
    if (userId === undefined) return false;
    return userId === this.options.ownerId || this.options.allowlist().includes(userId);
  }

  /** Users that get questions: the owner first, then the allowlist. */
  recipients(): number[] {
    return [...new Set([this.options.ownerId, ...this.options.allowlist()])];
  }

  /** Records an ignored update; logs at most once per user per window, and a bounded number overall. */
  ignored(userId: number | undefined, what: string): void {
    const now = this.options.clock.now().getTime();
    if (now - this.windowStart >= this.windowMs) {
      if (this.suppressed > 0) {
        this.options.log(`[telegram] ${this.suppressed} more updates from unknown users were ignored`);
      }
      this.windowStart = now;
      this.logsInWindow = 0;
      this.suppressed = 0;
    }
    const key = userId ?? 0;
    const last = this.lastLogged.get(key);
    if (last !== undefined && now - last < this.windowMs) return;
    if (this.logsInWindow >= this.maxLogs) {
      this.suppressed++;
      return;
    }
    if (this.lastLogged.size >= 1000) this.lastLogged.clear();
    this.lastLogged.set(key, now);
    this.logsInWindow++;
    this.options.log(
      `[telegram] ignored ${what} from user ${userId ?? 'unknown'} (not the owner or on the allowlist)`,
    );
  }
}
