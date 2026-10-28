import type { Rigor } from '@loop-engineering/core';

/**
 * The rigor dial (Session.rigor): one setting per session that trades safety against time and money.
 * Every level runs every stage; the level sets the agents' effort (core's RIGOR_EFFORT) and how strict
 * the checks are. This file is the whole policy besides that; the engine applies it on every step, so
 * a change reaches PRs already in the loop.
 */

/** Review rounds a Fast PR gets before it goes to the human. */
export const FAST_MAX_ROUNDS = 1;

/** Review rounds a Light PR gets before it goes to the human. */
export const LIGHT_MAX_ROUNDS = 2;

/** Fast and Light run the related existing tests and write none. */
const quick = (level: Rigor): boolean => level === 'fast' || level === 'light';

/** Whether the tester's new tests are pushed to the PR. */
export const pushesTests = (level: Rigor): boolean => !quick(level);

/**
 * The round cap. `rounds` is the PR's budget and `base` the loop's default for it: Fast and Light cut
 * the default budget, but rounds the human added ("Continue") stay theirs.
 */
export function rigorMaxRounds(level: Rigor, rounds: number, base: number): number {
  if (rounds > base) return rounds;
  if (level === 'fast') return Math.min(rounds, FAST_MAX_ROUNDS);
  if (level === 'light') return Math.min(rounds, LIGHT_MAX_ROUNDS);
  return rounds;
}

/** Thorough runs QA on every PR (when QA is in the pipeline), whatever the tester or the diff say. */
export const qaAlways = (level: Rigor): boolean => level === 'thorough';

/** What QA is told about why it runs, at Thorough. */
export const THOROUGH_QA_REASON = "the session's rigor is Thorough: QA runs on every PR";

/**
 * The line added to the tester's instructions. At Thorough it is left out once the loop has pushed
 * tests (it pushes them once per PR), since the prompt then tells the tester not to write more.
 */
export function testerNote(level: Rigor, testsAddedBefore: boolean): string {
  if (quick(level))
    return `Rigor ${rigorName(level)}: run only the existing tests related to the change, quickly; do not write new tests.`;
  if (level === 'thorough' && !testsAddedBefore)
    return 'Rigor Thorough: write tests for every behaviour the diff adds or changes, and run them with the related existing tests.';
  return '';
}

/** The line added to the reviewer's instructions. */
export function reviewerNote(level: Rigor): string {
  if (quick(level))
    return `Rigor ${rigorName(level)}: only correctness bugs and security problems are blocking; everything else is optional.`;
  if (level === 'thorough')
    return 'Rigor Thorough: also weigh edge cases, error handling and missing tests, and make real gaps blocking.';
  return '';
}

const LEVEL_NAMES: Record<Rigor, string> = {
  fast: 'Fast',
  light: 'Light',
  standard: 'Standard',
  thorough: 'Thorough',
};

export const rigorName = (level: Rigor): string => LEVEL_NAMES[level];
