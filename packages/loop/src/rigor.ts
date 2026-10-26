import { RIGOR_LEVELS, type Rigor } from '@loop-engineering/core';

/**
 * The rigor dial (Session.rigor): one setting per session that trades safety against time and money.
 * This file is the whole policy; the engine applies it on every step, so a change reaches PRs already
 * in the loop, and the server hands rigorByLevel() to the dashboard so it never restates it.
 */

/** Light keeps only these built-in checks of the pipeline. */
const LIGHT_CHECKS = ['tests', 'review'];

/** Review rounds a Light PR gets before it goes to the human. */
export const LIGHT_MAX_ROUNDS = 2;

/** The checks a PR at `level` runs, in the pipeline's order. */
export function rigorChecks(level: Rigor, checks: readonly string[]): string[] {
  if (level === 'fast') return [];
  if (level === 'light') return checks.filter((id) => LIGHT_CHECKS.includes(id));
  return [...checks];
}

/** For each level, the checks it runs from `checks`: what the dashboard draws. */
export function rigorByLevel(checks: readonly string[]): Record<Rigor, string[]> {
  return Object.fromEntries(RIGOR_LEVELS.map((level) => [level, rigorChecks(level, checks)])) as Record<
    Rigor,
    string[]
  >;
}

/**
 * The round cap. `rounds` is the PR's budget and `base` the loop's default for it: Light cuts the
 * default budget to LIGHT_MAX_ROUNDS, but rounds the human added ("Continue") stay theirs.
 */
export function rigorMaxRounds(level: Rigor, rounds: number, base: number): number {
  return level === 'light' && rounds <= base ? Math.min(rounds, LIGHT_MAX_ROUNDS) : rounds;
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
  if (level === 'light')
    return 'Rigor Light: run the existing tests related to the change; do not write new tests.';
  if (level === 'thorough' && !testsAddedBefore)
    return 'Rigor Thorough: write tests for every behaviour the diff adds or changes, and run them with the related existing tests.';
  return '';
}

/** The line added to the reviewer's instructions. */
export function reviewerNote(level: Rigor): string {
  if (level === 'light')
    return 'Rigor Light: only correctness bugs and security problems are blocking; everything else is optional.';
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
