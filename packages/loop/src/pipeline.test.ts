import { afterEach, describe, expect, it } from 'vitest';
import { verdictResult } from './fakes.js';
import { skipCheck } from './skip.js';
import { builtinStageLibrary, type Pipeline, type Stage, type StageLibrary } from './stages.js';
import { loopState } from './state.js';
import {
  blocking,
  clean,
  Harness,
  qaPass,
  SLUG,
  testsPass,
  type HarnessOptions,
} from './test-support/harness.js';

// The engine with an edited pipeline (stage files): order, removed checks, custom stages.

let open: Harness[] = [];
afterEach(() => {
  for (const h of open) h.close();
  open = [];
});

const security: Stage = {
  id: 'security',
  title: 'Security review',
  label: 'Security',
  icon: 'shield',
  access: 'read',
  runs: 'always',
  prompt: 'Look for leaked secrets.',
  builtin: false,
  overridden: false,
};

/** A library whose pipeline a test can change between ticks, like a hand edit of pipeline.json. */
function library(pipeline: Partial<Pipeline>, extra: Stage[] = []) {
  let current = builtinStageLibrary(pipeline, extra);
  const lib: StageLibrary & { set(p: Partial<Pipeline>): void } = {
    pipeline: () => current.pipeline(),
    stages: () => current.stages(),
    stage: (id) => current.stage(id),
    set: (p) => {
      current = builtinStageLibrary(p, extra);
    },
  };
  return lib;
}

function harness(stages: StageLibrary, options: HarnessOptions = {}): Harness {
  const h = new Harness({ ...options, deps: { ...options.deps, stages } });
  open.push(h);
  return h;
}

const checkPass = () => verdictResult({ passed: true, failures: [], summary: 'nothing found' });
const checkFail = (...failures: string[]) =>
  verdictResult({ passed: false, failures, summary: 'found some' });

describe('pipeline order', () => {
  it('runs the checks in the pipeline order: review before tests', async () => {
    const h = harness(library({ checks: ['review', 'tests'] }));
    h.launcher.on('review', clean()).on('tests', testsPass());
    await h.builderWithPr();
    await h.engine.tick();
    expect(h.launcher.kinds()).toEqual(['review', 'tests']);
    expect(h.pr()).toMatchObject({ outcome: 'merged', round: 1 });
  });

  it('after a fix, starts again from the first check', async () => {
    const h = harness(library({ checks: ['review', 'tests'] }));
    h.launcher
      .on('review', clean())
      .on('tests', verdictResult({ passed: false, failures: ['x fails'] }), testsPass());
    const { number } = await h.builderWithPr();
    await h.engine.tick();
    expect(loopState(h.pr()).feedback).toMatchObject({ kind: 'tests', items: ['x fails'] });
    h.github.push(SLUG, number);
    await h.engine.tick();
    expect(h.launcher.kinds()).toEqual(['review', 'tests', 'review', 'tests']);
    expect(h.pr()).toMatchObject({ outcome: 'merged', round: 2 });
  });
});

describe('removed checks', () => {
  it('without tests, CI still gates the merge', async () => {
    const h = harness(library({ checks: ['review'] }));
    h.launcher.on('review', clean());
    const { number } = await h.builderWithPr();
    h.github.pr(SLUG, number).checks = [{ name: 'build', bucket: 'pending' }];
    await h.engine.tick();
    expect(h.launcher.kinds()).toEqual(['review']);
    expect(h.pr()).toMatchObject({ stage: 'merge', outcome: null });
    h.github.pr(SLUG, number).checks = [{ name: 'build', bucket: 'pass' }];
    await h.engine.tick();
    expect(h.pr().outcome).toBe('merged');
  });

  it('without review, a PR waits for the human even with auto-merge on', async () => {
    const h = harness(library({ checks: ['tests'] }), { autoMerge: true });
    h.launcher.on('tests', testsPass());
    await h.builderWithPr();
    await h.engine.tick();
    expect(h.pr()).toMatchObject({ stage: 'awaiting_approval', outcome: null });
    const [q] = h.asked();
    expect(q?.text).toMatch(/passed its checks\. Merge it\?/);
    expect(q?.context).toContain('no code review');
  });

  it('with no checks at all, CI and the human decide', async () => {
    const h = harness(library({ checks: [] }));
    await h.builderWithPr();
    await h.engine.tick();
    expect(h.launcher.jobs).toEqual([]);
    expect(h.pr()).toMatchObject({ stage: 'awaiting_approval', round: 0 });
    expect(h.asked()[0]?.text).toMatch(/has no checks before merge\. Merge it\?/);
  });

  it('without QA, a UI change the tester flags merges without a browser check', async () => {
    const h = harness(library({ checks: ['tests', 'review'] }));
    h.github.diffFiles = ['checkout.tsx'];
    h.launcher.on('tests', testsPass({ qaNeeded: true, qaReason: 'checkout page' })).on('review', clean());
    await h.builderWithPr();
    await h.engine.tick();
    expect(h.launcher.kinds()).toEqual(['tests', 'review']);
    expect(h.pr().outcome).toBe('merged');
  });
});

describe('QA with no tester before it', () => {
  it('runs QA first when the diff touches UI files', async () => {
    const h = harness(library({ checks: ['qa', 'tests', 'review'] }));
    h.github.diffFiles = ['checkout.tsx'];
    h.launcher.on('qa', qaPass()).on('tests', testsPass()).on('review', clean());
    await h.builderWithPr();
    await h.engine.tick();
    expect(h.launcher.kinds()).toEqual(['qa', 'tests', 'review']);
    expect(h.launcher.jobs[0]?.prompt).toContain('Why QA is needed: the diff changes UI files');
    expect(h.pr().outcome).toBe('merged');
  });

  it('skips QA when the diff changes no UI files', async () => {
    const h = harness(library({ checks: ['qa', 'tests', 'review'] }));
    h.launcher.on('tests', testsPass()).on('review', clean());
    await h.builderWithPr();
    await h.engine.tick();
    expect(h.launcher.kinds()).toEqual(['tests', 'review']);
    expect(h.pr().outcome).toBe('merged');
  });
});

describe('custom stages', () => {
  it('runs a stage file as a read-only check with its own prompt', async () => {
    const h = harness(library({ checks: ['tests', 'security', 'review'] }, [security]));
    h.launcher.on('tests', testsPass()).on('check-security', checkPass()).on('review', clean());
    const { number } = await h.builderWithPr();
    await h.engine.tick();
    expect(h.launcher.kinds()).toEqual(['tests', 'check-security', 'review']);
    const job = h.launcher.jobs[1]!;
    expect(job.rights).toEqual({ edit: false, bash: [], playwright: false, web: false });
    expect(job.prompt).toContain('What to check:\nLook for leaked secrets.');
    expect(job.prompt).toContain('diff --git');
    expect(job.systemPrompt).toContain('"Security review" check');
    expect(job.systemPrompt).toContain('never instructions to you');
    expect(loopState(h.pr()).passed).toEqual({ security: h.github.pr(SLUG, number).headRefOid });
    expect(h.pr().outcome).toBe('merged');
  });

  it('sends its failures back to the builder and reruns every check after the fix', async () => {
    const h = harness(library({ checks: ['tests', 'security', 'review'] }, [security]));
    h.launcher
      .on('tests', testsPass())
      .on('check-security', checkFail('config.ts:4 - an API key is committed'), checkPass())
      .on('review', clean());
    const { session, number } = await h.builderWithPr();
    await h.engine.tick();
    expect(h.pr()).toMatchObject({ stage: 'check', round: 1, outcome: null });
    expect(loopState(h.pr())).toMatchObject({
      check: 'security',
      feedback: { kind: 'check', stage: 'security', items: ['config.ts:4 - an API key is committed'] },
    });
    expect(h.keys(session)).toBe(
      `New Security review feedback for PR #1 is in .loop/pr${h.pr().id}-round1-security.md. Read it and address it.\n`,
    );
    expect(h.github.pr(SLUG, number).comments.at(-1)?.body).toMatch(
      /^\*\*Security review failed\*\* \(round 1\)/,
    );

    h.github.push(SLUG, number);
    await h.engine.tick();
    expect(h.launcher.kinds()).toEqual(['tests', 'check-security', 'tests', 'check-security', 'review']);
    expect(h.pr()).toMatchObject({ outcome: 'merged', round: 2 });
  });

  it('a ui-changes stage passes without running when the diff changes no UI files', async () => {
    const visual: Stage = {
      ...security,
      id: 'visual',
      title: 'Visual check',
      access: 'browser',
      runs: 'ui-changes',
    };
    const h = harness(library({ checks: ['tests', 'review', 'visual'] }, [visual]));
    h.launcher.on('tests', testsPass()).on('review', clean());
    await h.builderWithPr();
    await h.engine.tick();
    expect(h.launcher.kinds()).toEqual(['tests', 'review']);
    expect(h.pr().outcome).toBe('merged');
  });

  it('a browser stage gets the browser and a shell, never edits', async () => {
    const visual: Stage = {
      ...security,
      id: 'visual',
      title: 'Visual check',
      access: 'browser',
      runs: 'ui-changes',
    };
    const h = harness(library({ checks: ['visual'] }, [visual]), { autoMerge: false });
    h.github.diffFiles = ['page.tsx'];
    h.launcher.on('check-visual', checkPass());
    await h.builderWithPr();
    await h.engine.tick();
    expect(h.launcher.jobs[0]?.rights).toMatchObject({ edit: false, bash: 'all', playwright: true });
  });
});

describe('editing the pipeline while a PR is in the loop', () => {
  it('a check added while a PR waits for approval runs in the same round', async () => {
    const lib = library({ checks: ['tests', 'review'] }, [security]);
    const h = harness(lib, { autoMerge: false });
    h.launcher.on('tests', testsPass()).on('review', clean()).on('check-security', checkPass());
    await h.builderWithPr();
    await h.engine.tick();
    expect(h.pr()).toMatchObject({ stage: 'awaiting_approval', round: 1 });

    lib.set({ checks: ['tests', 'review', 'security'] });
    await h.engine.tick();
    expect(h.launcher.kinds()).toEqual(['tests', 'review', 'check-security']);
    expect(h.pr()).toMatchObject({ stage: 'awaiting_approval', round: 1 });
  });

  it('a check removed while its feedback is out is not run after the fix', async () => {
    const lib = library({ checks: ['tests', 'review'] });
    const h = harness(lib, { autoMerge: false });
    h.launcher.on('tests', testsPass()).on('review', blocking('fix x'));
    const { number } = await h.builderWithPr();
    await h.engine.tick();
    expect(loopState(h.pr()).feedback?.kind).toBe('review');

    lib.set({ checks: ['tests'] });
    h.github.push(SLUG, number);
    await h.engine.tick();
    expect(h.launcher.kinds()).toEqual(['tests', 'review', 'tests']);
    expect(h.pr()).toMatchObject({ stage: 'awaiting_approval', round: 2 });
  });

  it('a PR sitting at a check that was removed moves on', async () => {
    const lib = library({ checks: ['tests', 'review', 'security'] }, [security]);
    const h = harness(lib);
    // The security job never answers in time: the PR stays at its stage between ticks.
    h.launcher.on('tests', testsPass()).on('review', clean()).on('check-security', verdictResult({}));
    await h.builderWithPr();
    await h.engine.tick();
    expect(h.pr()).toMatchObject({ stage: 'check', outcome: null });

    lib.set({ checks: ['tests', 'review'] });
    await h.engine.tick();
    expect(h.pr().outcome).toBe('merged');
  });
});

describe('fail closed: a broken stage file or pipeline.json never lets a PR skip a check', () => {
  /** A library as FileStageLibrary serves a broken folder: the stage kept with its error, or the pipeline's. */
  const broken = (pipeline: Pipeline, stages: Stage[]): StageLibrary => ({
    pipeline: () => pipeline,
    stages: () => [...builtinStageLibrary().stages(), ...stages],
    stage: (id) => stages.find((s) => s.id === id) ?? builtinStageLibrary().stage(id),
  });
  const on = { deploy: true, guardian: true };

  it('holds a PR at a check whose stage file does not parse', async () => {
    const h = harness(
      broken({ checks: ['tests', 'security'], ...on }, [{ ...security, error: 'no front matter' }]),
    );
    h.launcher.on('tests', testsPass());
    await h.builderWithPr();
    await h.engine.tick();
    await h.engine.tick();
    expect(h.launcher.kinds()).toEqual(['tests']);
    expect(h.pr()).toMatchObject({ stage: 'check', outcome: null });
    expect(loopState(h.pr())).toMatchObject({
      check: 'security',
      heldFor: 'stage security is broken: no front matter',
    });
    expect(h.logs.filter((l) => l.includes('waits: stage security'))).toHaveLength(1);
    expect(h.engine.status().active[0]).toMatchObject({
      heldFor: 'stage security is broken: no front matter',
    });
    // Held, the row is not written again on later ticks.
    const updated = h.pr().updatedAt;
    h.clock.advance(60_000);
    await h.engine.tick();
    expect(h.pr().updatedAt).toBe(updated);
  });

  it('holds a PR at a check whose stage file is gone', async () => {
    const h = harness(broken({ checks: ['ghost', 'tests'], ...on }, []));
    await h.builderWithPr();
    await h.engine.tick();
    expect(h.launcher.jobs).toEqual([]);
    expect(loopState(h.pr()).heldFor).toBe('stage ghost has no stage file');
    expect(h.pr().outcome).toBeNull();
  });

  it('merges nothing while pipeline.json cannot be read, even an approved head', async () => {
    const lib = library({ checks: ['tests', 'review'] });
    const h = harness(lib);
    h.launcher.on('tests', testsPass()).on('review', clean());
    await h.builderWithPr();
    const real = lib.pipeline();
    lib.pipeline = () => ({ ...real, error: 'pipeline.json: not valid JSON' });
    await h.engine.tick();
    expect(h.launcher.jobs).toEqual([]);
    expect(h.pr().outcome).toBeNull();
    expect(loopState(h.pr()).heldFor).toBe('pipeline.json: not valid JSON');
    lib.pipeline = () => real;
    await h.engine.tick();
    expect(h.pr().outcome).toBe('merged');
    expect(loopState(h.pr()).heldFor).toBeUndefined(); // lifted once it is fixed
  });

  it('neither watches nor reverts a deploy while pipeline.json cannot be read', async () => {
    const lib = library({});
    const h = harness(lib, { vercelProject: 'shop' });
    h.launcher.on('tests', testsPass()).on('review', clean());
    await h.builderWithPr();
    await h.engine.tick();
    expect(h.pr()).toMatchObject({ stage: 'deploying', outcome: 'merged' });
    const calls = h.deployments.calls.length;
    const real = lib.pipeline();
    lib.pipeline = () => ({ ...real, error: 'pipeline.json: not valid JSON' });
    await h.engine.tick();
    expect(h.deployments.calls).toHaveLength(calls);
    expect(h.pr().stage).toBe('deploying');
    lib.pipeline = () => real;
    await h.engine.tick();
    expect(h.deployments.calls.length).toBeGreaterThan(calls);
  });
});

describe('escalation after a custom stage', () => {
  it('"Continue" sends that stage\'s failures back as its own feedback, from the first check', async () => {
    const h = harness(library({ checks: ['security', 'tests'] }, [security]), { config: { maxRounds: 1 } });
    h.launcher.on('check-security', checkFail('a key is committed'));
    await h.builderWithPr();
    await h.engine.tick();
    expect(h.pr().stage).toBe('escalated');
    const q = h.asked().at(-1)!;
    h.answer(q.id, 'Continue 1 more');
    await h.engine.tick();
    expect(h.pr()).toMatchObject({ stage: 'check' });
    expect(loopState(h.pr())).toMatchObject({
      check: 'security',
      feedback: { kind: 'check', stage: 'security', items: ['a key is committed'] },
    });
  });
});

describe('after the merge', () => {
  it('with deploy off, a Vercel repo ends merged and its deploy is not watched', async () => {
    const h = harness(library({ deploy: false }), { vercelProject: 'shop' });
    h.launcher.on('tests', testsPass()).on('review', clean());
    await h.builderWithPr();
    await h.engine.tick();
    expect(h.pr()).toMatchObject({ stage: 'merge', outcome: 'merged' });
    expect(h.deployments.calls).toEqual([]);
  });

  it('with deploy on, the same repo is watched (the default)', async () => {
    const h = harness(library({}), { vercelProject: 'shop' });
    h.launcher.on('tests', testsPass()).on('review', clean());
    await h.builderWithPr();
    await h.engine.tick();
    expect(h.pr()).toMatchObject({ stage: 'deploying', outcome: 'merged' });
  });
});

describe('the human skips a check for one PR', () => {
  it('skipping failing tests drops their send-back and moves on', async () => {
    const lib = library({});
    const h = harness(lib);
    h.launcher.on('tests', verdictResult({ passed: false, failures: ['x fails'] })).on('review', clean());
    await h.builderWithPr();
    await h.engine.tick();
    expect(loopState(h.pr()).feedback?.kind).toBe('tests');
    skipCheck(h.store, lib, h.pr().id, 'tests', true);
    await h.engine.tick();
    expect(h.launcher.kinds()).toEqual(['tests', 'review']);
    expect(h.pr()).toMatchObject({ outcome: 'merged' });
    expect(h.store.history.list({ projectId: h.project.id }).map((e) => e.text)).toContain(
      'PR web#1: the human skipped Tests (dashboard).',
    );
  });

  it('a skipped code review still leaves the merge to the human, even with auto-merge on', async () => {
    const lib = library({});
    const h = harness(lib, { autoMerge: true });
    h.launcher.on('tests', testsPass()).on('review', blocking('fix x'));
    await h.builderWithPr();
    await h.engine.tick();
    skipCheck(h.store, lib, h.pr().id, 'review', true);
    await h.engine.tick();
    expect(h.pr()).toMatchObject({ stage: 'awaiting_approval', outcome: null });
    expect(h.asked().at(-1)?.context).toContain('no code review');
  });

  it('stays skipped after new commits, and a skip taken back runs before merge', async () => {
    const lib = library({});
    const h = harness(lib, { autoMerge: false });
    h.launcher
      .on('tests', verdictResult({ passed: false, failures: ['x fails'] }), testsPass())
      .on('review', clean());
    const { number } = await h.builderWithPr();
    await h.engine.tick();
    skipCheck(h.store, lib, h.pr().id, 'tests', true);
    await h.engine.tick();
    h.github.push(SLUG, number);
    await h.engine.tick();
    expect(h.launcher.kinds()).toEqual(['tests', 'review', 'review']); // round 2: tests still skipped
    expect(h.pr()).toMatchObject({ stage: 'awaiting_approval', round: 2 });

    skipCheck(h.store, lib, h.pr().id, 'tests', false);
    await h.engine.tick();
    expect(h.launcher.kinds().at(-1)).toBe('tests');
    expect(h.pr()).toMatchObject({ stage: 'awaiting_approval', round: 2 });
    expect(loopState(h.pr()).skip).toBeUndefined();
  });

  it('refuses a check outside the pipeline and a PR that left the loop', async () => {
    const lib = library({ checks: ['tests', 'review'] });
    const h = harness(lib);
    h.launcher.on('tests', testsPass()).on('review', clean());
    await h.builderWithPr();
    await h.engine.tick();
    expect(() => skipCheck(h.store, lib, h.pr().id, 'tests', true)).toThrow(/not waiting on a check/); // merged
    const otherLib = library({ checks: ['tests'] });
    const other = harness(otherLib);
    other.launcher.on('tests', verdictResult({ passed: false, failures: ['x'] }));
    await other.builderWithPr();
    await other.engine.tick();
    expect(() => skipCheck(other.store, otherLib, other.pr().id, 'qa', true)).toThrow(
      /not a check of the pipeline/,
    );
  });
});
