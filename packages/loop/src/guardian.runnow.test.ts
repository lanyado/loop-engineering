import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProductionGuardian } from './guardian.js';
import { verdictResult } from './fakes.js';
import { Harness } from './test-support/harness.js';

const URL = 'https://shop.example.com';

/** runNow: the on-demand path of the daily regression (no endpoint calls it yet, so no other tests). */
describe('ProductionGuardian.runNow', () => {
  let h: Harness;
  let guardian: ProductionGuardian;

  const build = () =>
    new ProductionGuardian(
      {
        store: h.store,
        github: h.github,
        launcher: h.launcher,
        workspace: h.workspace,
        questions: h.questions,
        timers: h.timers,
        log: () => undefined,
      },
      { evidenceDir: null },
    );

  beforeEach(() => {
    h = new Harness({ productionUrl: URL });
    guardian = build();
    h.launcher.on('guardian', verdictResult({ passed: true, critical: false, failures: [] }));
  });
  afterEach(() => h.close());

  it('runs a daily regression immediately even when the schedule would skip the repo', async () => {
    // The schedule has nothing to ask for today: mark the daily run as finished just now.
    const scheduled = h.store.guardianRuns.create({
      projectId: h.project.id,
      repo: 'web',
      trigger: 'daily',
    });
    h.store.guardianRuns.update(scheduled.id, { status: 'passed', finished: true });
    await guardian.tick();
    expect(h.launcher.jobs).toHaveLength(0); // not due

    const run = await guardian.runNow(h.project.id, 'web');
    expect(run).toMatchObject({ trigger: 'daily', prId: null, status: 'passed', requestId: null });
    expect(h.launcher.jobs).toHaveLength(4); // all four areas checked
    expect(h.store.guardianRuns.list({ repo: 'web', trigger: 'daily' })).toHaveLength(2);
  });

  it('returns null, without creating a run, for a repo without a productionUrl', async () => {
    h.store.projects.update(h.project.id, {
      repos: [{ name: 'web', path: '/src/web', remote: 'git@github.com:me/web.git', defaultBranch: 'main' }],
    });
    expect(await guardian.runNow(h.project.id, 'web')).toBeNull();
    expect(h.store.guardianRuns.list()).toEqual([]);
    expect(h.launcher.jobs).toEqual([]);
  });

  it('rejects an unknown project, and a repo the project does not have', async () => {
    await expect(guardian.runNow(999, 'web')).rejects.toThrow(/project 999/);
    expect(await guardian.runNow(h.project.id, 'nope')).toBeNull();
  });
});
