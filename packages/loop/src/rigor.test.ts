import { describe, expect, it } from 'vitest';
import {
  LIGHT_MAX_ROUNDS,
  qaAlways,
  reviewerNote,
  rigorByLevel,
  rigorChecks,
  rigorMaxRounds,
  testerNote,
} from './rigor.js';

const PIPELINE = ['tests', 'security', 'review', 'qa'];

describe('the rigor policy', () => {
  it('keeps the checks of each level in the pipeline order', () => {
    expect(rigorChecks('fast', PIPELINE)).toEqual([]);
    expect(rigorChecks('light', PIPELINE)).toEqual(['tests', 'review']);
    expect(rigorChecks('standard', PIPELINE)).toEqual(PIPELINE);
    expect(rigorChecks('thorough', PIPELINE)).toEqual(PIPELINE);
    expect(rigorChecks('light', ['review', 'qa', 'tests'])).toEqual(['review', 'tests']);
    expect(rigorChecks('light', ['qa'])).toEqual([]);
  });

  it('maps every level to its checks for the dashboard', () => {
    expect(rigorByLevel(PIPELINE)).toEqual({
      fast: [],
      light: ['tests', 'review'],
      standard: PIPELINE,
      thorough: PIPELINE,
    });
  });

  it('caps Light at two rounds, but keeps rounds the human added', () => {
    expect(rigorMaxRounds('light', 5, 5)).toBe(LIGHT_MAX_ROUNDS);
    expect(rigorMaxRounds('light', 1, 5)).toBe(1);
    expect(rigorMaxRounds('light', 7, 5)).toBe(7); // after "Continue 5 more"
    expect(rigorMaxRounds('standard', 5, 5)).toBe(5);
    expect(rigorMaxRounds('thorough', 5, 5)).toBe(5);
    expect(rigorMaxRounds('fast', 5, 5)).toBe(5);
  });

  it('runs QA on every PR only at Thorough', () => {
    expect(qaAlways('thorough')).toBe(true);
    expect(['fast', 'light', 'standard'].map((l) => qaAlways(l as never))).toEqual([false, false, false]);
  });

  it('tells the tester and the reviewer what the level asks, and nothing at Standard', () => {
    expect(testerNote('standard', false)).toBe('');
    expect(reviewerNote('standard')).toBe('');
    expect(testerNote('light', false)).toMatch(
      /run the existing tests related to the change; do not write new tests/,
    );
    expect(reviewerNote('light')).toMatch(/only correctness bugs and security problems are blocking/);
    expect(testerNote('thorough', false)).toMatch(/write tests for every behaviour the diff adds or changes/);
    expect(reviewerNote('thorough')).toMatch(/edge cases, error handling and missing tests/);
    // The loop pushes tests once per PR; after that the tester is told not to write more.
    expect(testerNote('thorough', true)).toBe('');
  });
});
