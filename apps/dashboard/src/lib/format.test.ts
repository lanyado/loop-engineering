import { describe, expect, it } from 'vitest';
import {
  formatAgo,
  formatCountdown,
  formatClock,
  formatDay,
  formatDuration,
  formatPrMetrics,
  formatTokens,
  newestFinishedFirst,
  parseIdList,
  pauseLabel,
  roundLabel,
  sessionRuntime,
  usageTone,
} from './format';

describe('format', () => {
  it('counts down to the deadline', () => {
    expect(formatCountdown(15 * 60_000)).toBe('15:00');
    expect(formatCountdown(61_001)).toBe('1:02');
    expect(formatCountdown(999)).toBe('0:01');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5000)).toBe('0:00');
  });

  it('formats durations and ages', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration(3 * 3_600_000 + 12 * 60_000)).toBe('3h 12m');
    expect(formatDuration(2 * 3_600_000)).toBe('2h');
    expect(formatDuration(26 * 3_600_000)).toBe('1d 2h');
    expect(formatDuration(-1)).toBe('0s');
    const now = Date.parse('2026-10-18T12:00:00.000Z');
    expect(sessionRuntime('2026-10-18T09:00:00.000Z', null, now)).toBe('3h');
    expect(sessionRuntime('2026-10-18T09:00:00.000Z', '2026-10-18T09:30:00.000Z', now)).toBe('30m');
    expect(formatAgo('2026-10-18T11:59:50.000Z', now)).toBe('just now');
    expect(formatAgo('2026-10-18T11:00:00.000Z', now)).toBe('1h ago');
  });

  it('labels pauses, rounds and usage, tolerating unknown values', () => {
    expect(usageTone(12)).toBe('active');
    expect(usageTone(70)).toBe('waiting');
    expect(usageTone(90)).toBe('bad');
    expect(pauseLabel(null)).toBeNull();
    expect(pauseLabel('usage_limit')).toBe('usage limit');
    expect(pauseLabel('agent_exited')).toBe('agent exited');
    expect(pauseLabel('new_reason')).toBe('New reason');
    expect(roundLabel(2)).toBe('round 2/5');
    expect(roundLabel(6, 10)).toBe('round 6/10'); // after "Continue 5 more"
    expect(roundLabel(3, 7, 'light')).toBe('round 3');
    expect(roundLabel(1, 5, 'thorough')).toBe('round 1/5');
  });

  it('parses the allowlist box', () => {
    expect(parseIdList('123, 456\n789 123')).toEqual({ ids: [123, 456, 789], invalid: [] });
    expect(parseIdList('12a -4 0 1.5 99999999999999999')).toEqual({
      ids: [],
      invalid: ['12a', '-4', '0', '1.5', '99999999999999999'],
    });
    expect(parseIdList('  ')).toEqual({ ids: [], invalid: [] });
  });

  it('formats the day a session happened', () => {
    expect(formatDay('2026-10-15T21:41:00.000Z', 'UTC')).toBe('15 Oct 2026');
    // The day is the local one: late evening UTC is already the next day in Jerusalem.
    expect(formatDay('2026-10-15T22:30:00.000Z', 'Asia/Jerusalem')).toBe('16 Oct 2026');
  });

  it('formats the time of day, in the given zone', () => {
    expect(formatClock('2026-10-15T21:41:00.000Z', 'UTC')).toBe('21:41');
    expect(formatClock('2026-10-15T22:05:00.000Z', 'Asia/Jerusalem')).toBe('01:05');
  });

  it('sorts finished sessions by when they ended, newest first', () => {
    const s = (id: number, endedAt: string | null, createdAt = '2026-01-01T00:00:00.000Z') => ({
      id,
      createdAt,
      endedAt,
    });
    const sorted = newestFinishedFirst([
      s(1, '2026-10-01T00:00:00.000Z'),
      s(2, '2026-10-03T00:00:00.000Z'),
      s(3, null, '2026-10-02T00:00:00.000Z'),
      s(4, '2026-10-03T00:00:00.000Z'),
    ]);
    expect(sorted.map((x) => x.id)).toEqual([4, 2, 3, 1]);
  });

  it('abbreviates token counts', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(842)).toBe('842');
    expect(formatTokens(128_400)).toBe('128k');
    expect(formatTokens(1_936_000)).toBe('1.9M');
    expect(formatTokens(2_000_000)).toBe('2M');
  });

  it("sums a PR's loop metrics into one line, leaving out zero failures", () => {
    const m = { costUsd: 0.42, tokensIn: 100_000, tokensOut: 28_000, rounds: 2, failures: 1 };
    expect(formatPrMetrics(m)).toBe('$0.42 · 128k tokens · 2 rounds · 1 failure');
    expect(formatPrMetrics({ ...m, failures: 3 })).toBe('$0.42 · 128k tokens · 2 rounds · 3 failures');
    expect(formatPrMetrics({ ...m, rounds: 1, failures: 0 })).toBe('$0.42 · 128k tokens · 1 round');
    expect(formatPrMetrics({ ...m, costUsd: 0, tokensIn: 0, tokensOut: 0 })).toBe(
      '$0.00 · 0 tokens · 2 rounds · 1 failure',
    );
  });
});
