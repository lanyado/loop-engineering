import { FakeClock } from '@loop-engineering/core';
import { describe, expect, it } from 'vitest';
import { FakeTimers } from './timers.js';

describe('FakeTimers', () => {
  it('fires due timers in time order at their own time, including ones scheduled while advancing', () => {
    const clock = new FakeClock('2026-10-18T09:00:00.000Z');
    const timers = new FakeTimers(clock);
    const fired: string[] = [];
    timers.setTimeout(() => fired.push(`b@${clock.now().toISOString()}`), 2000);
    timers.setTimeout(() => {
      fired.push(`a@${clock.now().toISOString()}`);
      timers.setTimeout(() => fired.push(`c@${clock.now().toISOString()}`), 500);
    }, 1000);
    const cancelled = timers.setTimeout(() => fired.push('never'), 1500);
    timers.clearTimeout(cancelled);

    timers.advance(1600);
    expect(fired).toEqual(['a@2026-10-18T09:00:01.000Z', 'c@2026-10-18T09:00:01.500Z']);
    expect(clock.now().toISOString()).toBe('2026-10-18T09:00:01.600Z');
    timers.advance(10_000);
    expect(fired.at(-1)).toBe('b@2026-10-18T09:00:02.000Z');
    expect(timers.pending).toBe(0);
  });
});
