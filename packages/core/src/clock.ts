/** Source of "now". Inject a FakeClock in tests instead of reading the system time. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Manually driven clock for tests. */
export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date | string | number = '2026-01-01T00:00:00.000Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(to: Date | string | number): void {
    this.current = new Date(to).getTime();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/** Timestamps are stored and exposed as ISO-8601 UTC strings, which sort lexicographically. */
export function isoNow(clock: Clock): string {
  return clock.now().toISOString();
}
