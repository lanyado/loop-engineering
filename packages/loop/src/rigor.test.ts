import { effortFor, RIGOR_LEVELS } from '@loop-engineering/core';
import { describe, expect, it } from 'vitest';
import {
  FAST_MAX_ROUNDS,
  LIGHT_MAX_ROUNDS,
  pushesTests,
  qaAlways,
  reviewerNote,
  rigorMaxRounds,
  testerNote,
} from './rigor.js';

describe('the rigor policy', () => {
  it('caps Fast at one round and Light at two, but keeps rounds the human added', () => {
    expect(rigorMaxRounds('fast', 5, 5)).toBe(FAST_MAX_ROUNDS);
    expect(rigorMaxRounds('light', 5, 5)).toBe(LIGHT_MAX_ROUNDS);
    expect(rigorMaxRounds('light', 1, 5)).toBe(1);
    expect(rigorMaxRounds('light', 7, 5)).toBe(7); // after "Continue 5 more"
    expect(rigorMaxRounds('fast', 6, 5)).toBe(6);
    expect(rigorMaxRounds('standard', 5, 5)).toBe(5);
    expect(rigorMaxRounds('thorough', 5, 5)).toBe(5);
  });

  it('runs QA on every PR only at Thorough', () => {
    expect(qaAlways('thorough')).toBe(true);
    expect(['fast', 'light', 'standard'].map((l) => qaAlways(l as never))).toEqual([false, false, false]);
  });

  it("pushes the tester's tests only at Standard and Thorough", () => {
    expect(RIGOR_LEVELS.map(pushesTests)).toEqual([false, false, true, true]);
  });

  it("maps the levels to the agents' effort; Standard keeps what the session has", () => {
    expect(RIGOR_LEVELS.map((l) => effortFor(l))).toEqual(['low', 'medium', null, 'max']);
    expect(effortFor('standard', 'xhigh')).toBe('xhigh');
    expect(effortFor('fast', 'xhigh')).toBe('low');
  });

  it('tells the tester and the reviewer what the level asks, and nothing at Standard', () => {
    expect(testerNote('standard', false)).toBe('');
    expect(reviewerNote('standard')).toBe('');
    for (const [level, name] of [
      ['fast', 'Fast'],
      ['light', 'Light'],
    ] as const) {
      expect(testerNote(level, false)).toMatch(
        new RegExp(
          `Rigor ${name}: run only the existing tests related to the change.*do not write new tests`,
        ),
      );
      expect(reviewerNote(level)).toMatch(
        new RegExp(`Rigor ${name}: only correctness bugs and security problems are blocking`),
      );
    }
    expect(testerNote('thorough', false)).toMatch(/write tests for every behaviour the diff adds or changes/);
    expect(reviewerNote('thorough')).toMatch(/edge cases, error handling and missing tests/);
    // The loop pushes tests once per PR; after that the tester is told not to write more.
    expect(testerNote('thorough', true)).toBe('');
  });
});
