import type { Question } from '@loop-engineering/core';
import type { Unsubscribe } from './bus.js';
import type { QuestionService } from './service.js';
import { systemTimers, type TimerHandle, type Timers } from './timers.js';

export interface DeadlineSweeperOptions {
  timers?: Timers;
  /**
   * Longest single wait before re-checking, default 60s. Deadlines are wall-clock times but timers
   * measure elapsed time, so a capped wait lets the sweep catch up after the Mac sleeps or the
   * clock jumps.
   */
  maxDelayMs?: number;
}

/**
 * Defaults questions at their deadline. It keeps one timer aimed at the earliest pending deadline
 * (store.questions.nextDeadline()), re-aims it whenever a question is created, and on start sweeps
 * anything that came due while the server was down. All state is in SQLite, so a restarted server
 * picks up where the old one stopped.
 */
export class DeadlineSweeper {
  private readonly timers: Timers;
  private readonly maxDelayMs: number;
  private timer: TimerHandle | null = null;
  private unsubscribe: Unsubscribe | null = null;

  constructor(
    private readonly service: QuestionService,
    options: DeadlineSweeperOptions = {},
  ) {
    this.timers = options.timers ?? systemTimers;
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
  }

  get running(): boolean {
    return this.unsubscribe !== null;
  }

  start(): void {
    if (this.running) return;
    this.unsubscribe = this.service.bus.on('question.created', () => this.schedule());
    this.sweep();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clear();
  }

  /** Defaults every due question now, then re-aims the timer. Returns what it defaulted. */
  sweep(): Question[] {
    try {
      return this.service.expireDue();
    } finally {
      this.schedule();
    }
  }

  private schedule(): void {
    this.clear();
    if (!this.running) return;
    const next = this.service.store.questions.nextDeadline();
    if (next === null) return;
    const wait = Date.parse(next) - this.service.store.clock.now().getTime();
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = null;
        try {
          this.sweep();
        } catch (error) {
          // sweep() has already re-aimed the timer, so the next attempt still happens.
          console.error('[ask-human] deadline sweep failed:', error);
        }
      },
      Math.min(Math.max(wait, 0), this.maxDelayMs),
    );
  }

  private clear(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}
