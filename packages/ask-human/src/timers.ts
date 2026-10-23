import type { FakeClock } from '@loop-engineering/core';

/** Opaque handle returned by Timers.setTimeout. */
export type TimerHandle = { readonly __timer: unique symbol };

/** Scheduling side of the clock. Inject FakeTimers in tests so timeouts fire when the FakeClock moves. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Real timers. They are unref'd: a pending sweep alone never keeps the process alive. */
export const systemTimers: Timers = {
  setTimeout(fn, ms) {
    const t = setTimeout(fn, Math.max(0, ms));
    t.unref();
    return t as unknown as TimerHandle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as unknown as NodeJS.Timeout);
  },
};

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

/** Timers driven by a FakeClock: advance() moves the clock and runs every timer that comes due, in order. */
export class FakeTimers implements Timers {
  private timers: FakeTimer[] = [];
  private nextId = 1;

  constructor(readonly clock: FakeClock) {}

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.push({ id, at: this.clock.now().getTime() + Math.max(0, ms), fn });
    return id as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.id !== (handle as unknown as number));
  }

  /** Number of scheduled timers that have not fired. */
  get pending(): number {
    return this.timers.length;
  }

  /** Moves the clock forward by `ms`, firing due timers at their own time (timers they schedule included). */
  advance(ms: number): void {
    const target = this.clock.now().getTime() + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      if (due.at > this.clock.now().getTime()) this.clock.set(due.at);
      due.fn();
    }
    this.clock.set(target);
  }
}
