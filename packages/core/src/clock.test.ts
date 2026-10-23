import { describe, expect, it } from 'vitest';
import { FakeClock, isoNow, systemClock } from './clock.js';

describe('clock', () => {
  it('FakeClock is set and advanced by hand', () => {
    const clock = new FakeClock('2026-10-18T09:00:00.000Z');
    clock.advance(90_000);
    expect(isoNow(clock)).toBe('2026-10-18T09:01:30.000Z');
    clock.set('2027-01-01T00:00:00.000Z');
    expect(clock.now().getUTCFullYear()).toBe(2027);
  });

  it('FakeClock.now returns a copy', () => {
    const clock = new FakeClock();
    clock.now().setTime(0);
    expect(isoNow(clock)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('systemClock reads real time', () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000);
  });
});
