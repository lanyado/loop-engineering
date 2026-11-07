import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GuardianArea } from '@loop-engineering/core';
import { ExecError } from '@loop-engineering/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductionGuardian, type GuardianConfig } from './guardian.js';
import { verdictResult } from './fakes.js';
import type { AgentJob, AgentJobResult } from './ports.js';
import { builtinStageLibrary } from './stages.js';
import { loopState } from './state.js';
import { Harness, SLUG } from './test-support/harness.js';

const URL = 'https://shop.example.com';
const HOUR = 3_600_000;

const pass = () => verdictResult({ passed: true, critical: false, failures: [] });
const fail = (critical: boolean, ...failures: string[]) =>
  verdictResult({ passed: false, critical, failures });
const crash = (): AgentJobResult => ({ text: 'boom', costUsd: 0, tokensIn: 0, tokensOut: 0, isError: true });
const DIAGNOSIS: AgentJobResult = {
  text: 'The checkout route returns 500: look at app/checkout.ts:12.',
  costUsd: 0.1,
  tokensIn: 10,
  tokensOut: 10,
  isError: false,
};

const AREA_MARK: Record<GuardianArea, string> = {
  api: 'API check',
  ui: 'UI check',
  performance: 'Performance check',
  integrations: 'Integrations check',
};

/** The area a guardian job checks, from its prompt; "diagnose" for the analyst. */
function areaOf(job: AgentJob): GuardianArea | 'diagnose' {
  if (job.prompt.includes("failed the Production Guardian's checks")) return 'diagnose';
  const found = (Object.keys(AREA_MARK) as GuardianArea[]).find((a) => job.prompt.includes(AREA_MARK[a]));
  if (!found) throw new Error('not a guardian prompt');
  return found;
}

/** Answers each area from its own queue of results (the last repeats); everything passes by default. */
function answers(plan: Partial<Record<GuardianArea | 'diagnose', AgentJobResult[]>> = {}) {
  const queues = new Map(Object.entries(plan).map(([k, v]) => [k, [...v]]));
  return (job: AgentJob): AgentJobResult => {
    const area = areaOf(job);
    const queue = queues.get(area) ?? [area === 'diagnose' ? DIAGNOSIS : pass()];
    return queue.length > 1 ? queue.shift()! : queue[0]!;
  };
}

describe('ProductionGuardian', () => {
  let h: Harness;
  let evidence: string;
  let guardian: ProductionGuardian;

  const build = (config: Partial<GuardianConfig> = {}) => {
    guardian = new ProductionGuardian(
      {
        store: h.store,
        github: h.github,
        launcher: h.launcher,
        workspace: h.workspace,
        questions: h.questions,
        timers: h.timers,
        log: (m) => h.logs.push(m),
      },
      { evidenceDir: evidence, ...config },
    );
  };

  /** A PR the loop merged, deployed and finished with. */
  const deployedPr = (done = true) => {
    const gh = h.github.open(SLUG, { branch: 'loop/x', title: 'Add Apple Pay' });
    const row = h.store.pullRequests.create({
      projectId: h.project.id,
      repo: 'web',
      number: gh.number,
      url: gh.url,
    });
    return h.store.pullRequests.update(row.id, {
      stage: 'deployed',
      outcome: 'merged',
      mergeCommitSha: 'c0ffee'.padEnd(40, '0'),
      loopState: done ? { done: true } : {},
    });
  };

  const on = (plan: Parameters<typeof answers>[0] = {}) => h.launcher.on('guardian', answers(plan));

  /** Waits for `promise`, firing the guardian's timers (checkout retries, slot waits) as they come due. */
  async function settle<T>(promise: Promise<T>, stepMs = 5000): Promise<T> {
    let done = false;
    void promise.finally(() => (done = true)).catch(() => undefined);
    while (!done) {
      await new Promise((next) => setImmediate(next));
      h.timers.advance(stepMs);
    }
    return promise;
  }

  beforeEach(() => {
    h = new Harness({ productionUrl: URL, vercelProject: 'shop' });
    evidence = mkdtempSync(join(tmpdir(), 'guardian-'));
    build();
  });
  afterEach(() => {
    h.close();
    rmSync(evidence, { recursive: true, force: true });
  });

  it.each([
    ['has no Guardian', { guardian: false }],
    ['cannot be read', { error: 'pipeline.json: not valid JSON' }],
  ])('runs nothing on schedule when the pipeline %s', async (_, change) => {
    guardian = new ProductionGuardian(
      {
        store: h.store,
        github: h.github,
        launcher: h.launcher,
        workspace: h.workspace,
        questions: h.questions,
        timers: h.timers,
        stages: {
          ...builtinStageLibrary(),
          pipeline: () => ({ ...builtinStageLibrary().pipeline(), ...change }),
        },
        log: (m) => h.logs.push(m),
      },
      { evidenceDir: evidence },
    );
    deployedPr();
    on();
    await guardian.tick();
    expect(h.store.guardianRuns.list()).toEqual([]);
    expect(h.launcher.jobs).toEqual([]);
  });

  it("follows the project's own pipeline: its Guardian switch and its instructions", async () => {
    const base = builtinStageLibrary();
    const off = { ...base, pipeline: () => ({ ...base.pipeline(), guardian: false }) };
    const own = { ...base, guardian: () => ({ ...base.guardian(), prompt: 'Also open the basket page.' }) };
    let library = off;
    const asked: number[] = [];
    guardian = new ProductionGuardian(
      {
        store: h.store,
        github: h.github,
        launcher: h.launcher,
        workspace: h.workspace,
        questions: h.questions,
        timers: h.timers,
        stages: {
          forProject: (project) => {
            asked.push(project.id);
            return library;
          },
        },
        log: (m) => h.logs.push(m),
      },
      { evidenceDir: evidence },
    );
    deployedPr();
    on();
    await guardian.tick();
    expect(h.store.guardianRuns.list()).toEqual([]);
    library = own;
    await guardian.tick();
    expect(h.store.guardianRuns.list()).toHaveLength(1);
    expect(JSON.stringify(h.launcher.jobs[0])).toContain('Also open the basket page.');
    expect(new Set(asked)).toEqual(new Set([h.project.id]));
  });

  describe('after a deploy', () => {
    // The daily regression is independent of deploys; mark today's as done so only deploy runs show here.
    beforeEach(() => {
      const daily = h.store.guardianRuns.create({ projectId: h.project.id, repo: 'web', trigger: 'daily' });
      h.store.guardianRuns.update(daily.id, { status: 'passed', finished: true });
    });

    it('checks the four areas on the merge commit and passes', async () => {
      const pr = deployedPr();
      on();
      await guardian.tick();

      const [, run] = h.store.guardianRuns.list();
      expect(run).toMatchObject({
        trigger: 'deploy',
        prId: pr.id,
        status: 'passed',
        critical: false,
        requestId: null,
      });
      expect(run!.areas.map((a) => a.area)).toEqual(['api', 'ui', 'performance', 'integrations']);
      expect(h.launcher.jobs).toHaveLength(4);
      expect(h.workspace.checkouts.every((c) => c.sha === pr.mergeCommitSha && c.branch === 'main')).toBe(
        true,
      );
      expect(h.launcher.jobs.every((j) => j.rights.edit === false && j.cwd.startsWith('/jobs/'))).toBe(true);
      // The agent is told what was deployed and which URL to check.
      expect(h.launcher.jobs[0]!.prompt).toContain(URL);
      expect(h.launcher.jobs[0]!.prompt).toContain('Add Apple Pay');
      // And the user's instructions for every run (the built-in guardian.md here).
      expect(h.launcher.jobs[0]!.prompt).toContain(builtinStageLibrary().guardian().prompt);
      expect(h.workspace.live.size).toBe(0);
      expect(loopState(h.store.pullRequests.require(pr.id)).guardian).toMatchObject({
        runId: run!.id,
        status: 'passed',
      });
      expect(h.store.metrics.get(pr.id).costUsd).toBeGreaterThan(0);

      await guardian.tick();
      expect(h.store.guardianRuns.list({ trigger: 'deploy' })).toHaveLength(1); // the deploy is verified once
    });

    it('leaves a PR the loop is not done with, and a repo with no productionUrl, alone', async () => {
      deployedPr(false);
      on();
      await guardian.tick();
      expect(h.store.guardianRuns.list({ trigger: 'deploy' })).toEqual([]);

      h.store.projects.update(h.project.id, {
        repos: [
          { name: 'web', path: '/src/web', remote: 'git@github.com:me/web.git', defaultBranch: 'main' },
        ],
      });
      await guardian.tick();
      expect(h.store.guardianRuns.list({ trigger: 'deploy' })).toEqual([]);
    });

    it('does not verify a deploy that is older than the window when first seen', async () => {
      deployedPr();
      h.clock.advance(7 * HOUR);
      on();
      await guardian.tick();
      expect(h.store.guardianRuns.list({ trigger: 'deploy' })).toEqual([]);
    });

    it('retries a failing area once and treats a pass on retry as flaky, not a failure', async () => {
      deployedPr();
      on({ api: [fail(false, 'GET /health 503'), pass()] });
      await guardian.tick();

      const [, run] = h.store.guardianRuns.list();
      expect(run).toMatchObject({ status: 'passed', requestId: null });
      expect(run!.areas.find((a) => a.area === 'api')).toMatchObject({ passed: true, flaky: true });
      expect(run!.summary).toContain('api only on retry');
      const retry = h.launcher.jobs.filter((j) => areaOf(j) === 'api');
      expect(retry).toHaveLength(2);
      expect(retry[1]!.prompt).toContain('GET /health 503');
      expect(h.asked()).toEqual([]);
    });

    it('on a failure after the retry: keeps evidence, diagnoses, files a fix task and alerts if critical', async () => {
      const pr = deployedPr();
      h.store.sessions.create({ projectId: h.project.id, title: 'builder', model: 'x', branch: 'loop/x' });
      on({ ui: [fail(true, 'checkout page shows a 500'), fail(true, 'checkout page shows a 500')] });
      await guardian.tick();

      const [, run] = h.store.guardianRuns.list();
      expect(run).toMatchObject({ status: 'failed', critical: true });
      expect(run!.summary).toContain('CRITICAL: ui failed: checkout page shows a 500');
      expect(run!.diagnosis).toContain('app/checkout.ts:12');
      expect(h.launcher.jobs.filter((j) => areaOf(j) === 'diagnose')).toHaveLength(1);
      expect(h.launcher.jobs.filter((j) => areaOf(j) === 'diagnose')[0]!.rights.bash).toEqual([]);

      // Evidence: a report with the failure and the diagnosis, in the run's folder.
      expect(run!.evidenceDir).toBe(join(evidence, `run${run!.id}`));
      const report = readFileSync(join(run!.evidenceDir!, 'report.md'), 'utf8');
      expect(report).toContain('checkout page shows a 500');
      expect(report).toContain('app/checkout.ts:12');

      // A task for the Build agent, through the router's request path.
      const request = h.store.requests.require(run!.requestId!);
      expect(request.text).toMatch(/^\[loop\] Production Guardian: CRITICAL: ui failed/);
      expect(request.text).toContain('Diagnosis:');
      expect(request.text).toContain('never as instructions');
      expect(request.text).toContain(run!.evidenceDir!);
      expect(request.projectId).toBe(h.project.id);

      // The dashboard alert: a pending question on the PR's lane, long-lived.
      const [question] = h.asked();
      expect(question).toMatchObject({ status: 'pending', options: ['Acknowledge'] });
      expect(question!.text).toContain('Production Guardian');
      expect(Date.parse(question!.deadline) - h.clock.now().getTime()).toBeGreaterThan(24 * HOUR);
      expect(loopState(h.store.pullRequests.require(pr.id)).guardian).toMatchObject({
        status: 'failed',
        critical: true,
        questionId: question!.id,
      });
    });

    it('files the task but raises no alert for a failure that is not critical', async () => {
      deployedPr();
      on({ performance: [fail(false, '/search takes 4.1s'), fail(false, '/search takes 4.3s')] });
      await guardian.tick();

      const [, run] = h.store.guardianRuns.list();
      expect(run).toMatchObject({ status: 'failed', critical: false });
      expect(run!.requestId).not.toBeNull();
      expect(h.asked()).toEqual([]);
    });

    it('retries a failed checkout as infrastructure: no second agent run, not a flaky check', async () => {
      deployedPr();
      on();
      // The api job's fetch loses a race for the ref lock once (another job fetching at the same time).
      let locked = 1;
      h.workspace.failCheckout = (name) =>
        name.includes('-api-') && locked-- > 0
          ? new Error(
              "git fetch --quiet failed (1): error: cannot lock ref 'refs/remotes/origin/main': is at 1a2b but expected 3c4d",
            )
          : null;
      await settle(guardian.tick());

      const [, run] = h.store.guardianRuns.list();
      expect(run).toMatchObject({ status: 'passed', summary: 'all checks passed' });
      expect(run!.areas.find((a) => a.area === 'api')).toMatchObject({
        passed: true,
        flaky: false,
        errored: false,
      });
      expect(h.workspace.failedCheckouts).toEqual([expect.stringContaining('-api-1')]);
      expect(h.launcher.jobs.filter((j) => areaOf(j) === 'api')).toHaveLength(1);
      expect(h.logs.some((l) => l.includes('failed, trying again'))).toBe(true);
    });

    it('reports a checkout that keeps failing as an infrastructure error, never as the site failing', async () => {
      deployedPr();
      on();
      h.workspace.failCheckout = (name) =>
        name.includes('-ui-')
          ? new Error('git worktree add failed (128): fatal: No space left on device')
          : null;
      await settle(guardian.tick());

      const [, run] = h.store.guardianRuns.list();
      expect(run).toMatchObject({ status: 'error', requestId: null });
      expect(run!.summary).toMatch(
        /^infrastructure error: could not check ui: the ui check could not start: the job checkout failed 3 times/,
      );
      expect(run!.areas.find((a) => a.area === 'ui')).toMatchObject({
        passed: false,
        errored: true,
        infra: true,
        flaky: false,
      });
      // Tried as infrastructure (three checkouts), and no agent ever ran for it.
      expect(h.workspace.failedCheckouts).toEqual(['guardian2-ui-1', 'guardian2-ui-1', 'guardian2-ui-1']);
      expect(h.launcher.jobs.filter((j) => areaOf(j) === 'ui')).toEqual([]);
      expect(h.store.requests.list()).toEqual([]);
      expect(h.asked()).toEqual([]);
    });

    it('takes a heavy-run slot for each check before its time limit starts, and tells the agent the limit', async () => {
      const MINUTE = 60_000;
      const held: string[] = [];
      let acquired = 0;
      // The slots are busy for 20 minutes: longer than a check's own 15.
      const heavySlots = {
        acquire: () =>
          new Promise<() => void>((done) =>
            h.timers.setTimeout(() => {
              acquired++;
              held.push('slot');
              done(() => held.pop());
            }, 20 * MINUTE),
          ),
      };
      guardian = new ProductionGuardian(
        {
          store: h.store,
          github: h.github,
          launcher: h.launcher,
          workspace: h.workspace,
          questions: h.questions,
          timers: h.timers,
          heavySlots,
          log: (m) => h.logs.push(m),
        },
        { evidenceDir: evidence },
      );
      deployedPr();
      on({ ui: [fail(false, 'menu is broken'), fail(false, 'menu is broken')] });
      await settle(guardian.tick(), MINUTE);

      const [, run] = h.store.guardianRuns.list();
      expect(run).toMatchObject({ status: 'failed' }); // the checks ran: the wait was not job time
      expect(acquired).toBe(5); // four areas and the ui retry; the diagnosis runs no browser
      expect(held).toEqual([]);
      const check = h.launcher.jobs.find((j) => areaOf(j) === 'api')!;
      // Told it holds a slot only when it does: the diagnosis holds none.
      expect(check.env).toEqual({ LOOP_HEAVY_HELD: '1' });
      expect(h.launcher.jobs.find((j) => areaOf(j) === 'diagnose')!.env).toBeUndefined();
      expect(check.prompt).toContain('you have 15 minutes');
      expect(check.prompt).not.toContain('Stop any process you started');
      expect(check.systemPrompt).toContain('Never stop processes by name or pattern (pkill, killall');
    });

    it('stops at once while checks wait for heavy-run slots, holding at most one slot per job permit', async () => {
      let asked = 0;
      // Every slot on the machine is busy, for longer than anyone waits here.
      const heavySlots = {
        acquire: (signal: AbortSignal) => {
          asked++;
          return new Promise<() => void>((_, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true }),
          );
        },
      };
      guardian = new ProductionGuardian(
        {
          store: h.store,
          github: h.github,
          launcher: h.launcher,
          workspace: h.workspace,
          questions: h.questions,
          timers: h.timers,
          heavySlots,
          log: (m) => h.logs.push(m),
        },
        { evidenceDir: evidence },
      );
      deployedPr();
      on();
      const tick = guardian.tick();
      await vi.waitFor(() => expect(asked).toBe(2)); // maxConcurrentJobs: the other two areas wait for a permit
      const stopped = await Promise.race([
        guardian.stop().then(() => 'stopped'),
        new Promise((done) => setTimeout(() => done('still waiting'), 2000)),
      ]);
      expect(stopped).toBe('stopped'); // without advancing the timers
      await tick;
      expect(asked).toBe(2); // no check started waiting after stop()
      expect(h.launcher.jobs).toEqual([]);
      expect(h.store.guardianRuns.list({ trigger: 'deploy' })[0]).toMatchObject({ status: 'error' });
    });

    it("says what git answered when a checkout keeps failing, not git's long command line", async () => {
      deployedPr();
      on();
      const guard = Array.from({ length: 40 }, (_, i) => `-c guard.key${i}=value`).join(' ');
      h.workspace.failCheckout = (name) =>
        name.includes('-ui-')
          ? new ExecError(
              `git ${guard} worktree add --no-checkout --detach --force -- /jobs/x c0ffee`,
              128,
              'fatal: No space left on device\n',
            )
          : null;
      await settle(guardian.tick());
      const [, run] = h.store.guardianRuns.list();
      expect(run!.summary).toContain('the job checkout failed 3 times (fatal: No space left on device)');
      expect(run!.summary).not.toContain('guard.key');
    });

    it("shows a check's real failure when its retry could not start, not an infrastructure error", async () => {
      deployedPr();
      on({ ui: [fail(false, 'the menu does not open')] });
      h.workspace.failCheckout = (name) =>
        name.endsWith('-ui-2')
          ? new Error('git worktree add failed (128): fatal: No space left on device')
          : null;
      await settle(guardian.tick());

      const [, run] = h.store.guardianRuns.list();
      expect(run).toMatchObject({ status: 'error', requestId: null });
      expect(run!.summary).toBe('could not check ui: the menu does not open');
      const ui = run!.areas.find((a) => a.area === 'ui')!;
      expect(ui).toMatchObject({ passed: false, errored: true, flaky: false });
      expect(ui.infra).toBeUndefined();
      expect(ui.failures).toEqual([
        'the menu does not open',
        expect.stringMatching(
          /^not confirmed: the ui check could not start: the job checkout failed 3 times/,
        ),
      ]);
    });

    it('does not count a crashed check as a production failure, and retries the run later up to the cap', async () => {
      deployedPr();
      h.launcher.on('guardian', crash);
      await guardian.tick();

      let runs = h.store.guardianRuns.list({ trigger: 'deploy' });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: 'error', requestId: null });
      expect(runs[0]!.areas.every((a) => a.errored)).toBe(true);
      expect(h.store.requests.list()).toEqual([]);
      expect(h.launcher.jobs).toHaveLength(8); // each area tried twice

      await guardian.tick();
      expect(h.store.guardianRuns.list({ trigger: 'deploy' })).toHaveLength(1); // too soon

      for (let i = 0; i < 4; i++) {
        h.clock.advance(31 * 60_000);
        await guardian.tick();
      }
      runs = h.store.guardianRuns.list({ trigger: 'deploy' });
      expect(runs).toHaveLength(3); // maxErrorRuns
    });
  });

  describe('once a day', () => {
    it('alerts the human once when infrastructure errors leave production unchecked for 3 runs in a row', async () => {
      on();
      h.workspace.failCheckout = () => new Error('git fetch failed (128): fatal: cannot read the git config');
      const questions = () => h.asked().filter((q) => q.text.includes('has not been checked'));
      for (let run = 1; run <= 3; run++) {
        await settle(guardian.tick());
        expect(h.store.guardianRuns.list()).toHaveLength(run);
        expect(h.store.guardianRuns.list().at(-1)!.summary).toMatch(/^infrastructure error: /);
        expect(questions()).toHaveLength(run === 3 ? 1 : 0);
        h.clock.advance(31 * 60_000);
      }
      const [alert] = questions();
      expect(alert!.text).toContain('has not been checked for 3 runs');
      expect(alert!.options).toEqual(['Acknowledge']);
      expect(h.store.requests.list()).toEqual([]); // nothing for a builder: the site was never checked
    });

    it('runs a regression for a guarded repo, then waits a day', async () => {
      on();
      await guardian.tick();
      const [run] = h.store.guardianRuns.list();
      expect(run).toMatchObject({ trigger: 'daily', prId: null, status: 'passed' });
      expect(h.workspace.checkouts[0]!.sha).toBe('refs/remotes/origin/main');
      expect(h.launcher.jobs[0]!.prompt).toContain('daily regression run');

      h.clock.advance(23 * HOUR);
      await guardian.tick();
      expect(h.store.guardianRuns.list()).toHaveLength(1);
      h.clock.advance(HOUR + 1);
      await guardian.tick();
      expect(h.store.guardianRuns.list()).toHaveLength(2);
    });

    it('files one fix task per ongoing failure, and a new one after production recovered', async () => {
      let broken = true;
      h.launcher.on('guardian', (job) => {
        const area = areaOf(job);
        if (area === 'diagnose') return DIAGNOSIS;
        return broken && area === 'api' ? fail(false, 'GET /api/items 500') : pass();
      });
      const nextDay = async () => {
        h.clock.advance(25 * HOUR);
        await guardian.tick();
      };
      await guardian.tick();
      await nextDay();
      const [first, second] = h.store.guardianRuns.list();
      expect(first!.status).toBe('failed');
      expect(second!.requestId).toBe(first!.requestId); // still the same problem: same task
      expect(h.store.requests.list()).toHaveLength(1);

      broken = false;
      await nextDay();
      broken = true;
      await nextDay();
      const runs = h.store.guardianRuns.list();
      expect(runs.map((r) => r.status)).toEqual(['failed', 'failed', 'passed', 'failed']);
      expect(runs[3]!.requestId).not.toBe(first!.requestId);
      expect(h.store.requests.list()).toHaveLength(2);
    });

    it('stops retrying a daily run that cannot execute after maxErrorRuns, then tries once a day', async () => {
      h.launcher.on('guardian', crash);
      for (let i = 0; i < 6; i++) {
        await guardian.tick();
        h.clock.advance(31 * 60_000);
      }
      expect(h.store.guardianRuns.list({ trigger: 'daily' })).toHaveLength(3);

      h.clock.advance(24 * HOUR);
      await guardian.tick();
      expect(h.store.guardianRuns.list({ trigger: 'daily' })).toHaveLength(4);
      h.clock.advance(31 * 60_000);
      await guardian.tick();
      expect(h.store.guardianRuns.list({ trigger: 'daily' })).toHaveLength(4); // a day again, not 30 min
    });

    it('does not run for a folder or a repo without a productionUrl', async () => {
      h.store.projects.create({ name: 'Notes', kind: 'folder', folderPath: evidence });
      h.store.projects.update(h.project.id, {
        repos: [
          { name: 'web', path: '/src/web', remote: 'git@github.com:me/web.git', defaultBranch: 'main' },
        ],
      });
      on();
      await guardian.tick();
      expect(h.store.guardianRuns.list()).toEqual([]);
    });
  });

  describe('network outages', () => {
    const MIN = 60_000;
    const cut = (text = 'API Error: Unable to connect: ECONNRESET'): AgentJobResult => ({
      text,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      isError: true,
    });
    /** What the api area answers: the outage while it lasts, else a pass like every other area. */
    let outage: AgentJobResult | null = null;
    beforeEach(() => {
      outage = cut();
      h.launcher.on('guardian', (job) => (outage && areaOf(job) === 'api' ? outage : answers()(job)));
    });
    const runs = (trigger?: 'deploy' | 'daily') => h.store.guardianRuns.list(trigger ? { trigger } : {});
    /** The run is skipped: nothing retried or diagnosed, no task, no alert. */
    const expectSkipped = (id: number) => {
      expect(h.store.guardianRuns.require(id)).toMatchObject({
        status: 'skipped',
        summary: 'skipped: offline',
        critical: false,
        requestId: null,
        diagnosis: '',
      });
      expect(h.launcher.jobs.filter((j) => areaOf(j) === 'diagnose')).toEqual([]);
      expect(h.store.requests.list()).toEqual([]);
      expect(h.asked()).toEqual([]);
    };

    it('records the daily run as skipped, then reruns it once the connection is back', async () => {
      await guardian.tick();
      expectSkipped(runs()[0]!.id);
      expect(h.launcher.jobs.filter((j) => areaOf(j) === 'api')).toHaveLength(1); // not retried
      expect(h.logs.filter((l) => l.startsWith('offline'))).toHaveLength(1);

      // Still down: no new run, only probes.
      h.github.offline = true;
      h.clock.advance(10 * MIN);
      await guardian.tick();
      await guardian.tick();
      expect(runs()).toHaveLength(1);

      // Back: the daily check is repeated, and the outage was no failed try.
      h.github.offline = false;
      outage = null;
      await guardian.tick();
      expect(runs().map((r) => r.status)).toEqual(['skipped', 'passed']);
      expect(h.logs.some((l) => l.startsWith('back online after 10 min'))).toBe(true);
    });

    it('does not repeat a skipped run within minutes (a flapping connection)', async () => {
      await guardian.tick();
      await guardian.tick();
      expect(runs()).toHaveLength(1);
      h.clock.advance(5 * MIN);
      await guardian.tick();
      expect(runs()).toHaveLength(2);
    });

    it('skips a post-deploy run and reruns it later, even after the deploy window', async () => {
      const daily = h.store.guardianRuns.create({ projectId: h.project.id, repo: 'web', trigger: 'daily' });
      h.store.guardianRuns.update(daily.id, { status: 'passed', finished: true });
      const pr = deployedPr();
      outage = cut('read tcp 10.0.0.2:1->1.1.1.1:443: operation timed out');
      await guardian.tick();
      const [skipped] = runs('deploy');
      expect(skipped).toMatchObject({ prId: pr.id });
      expectSkipped(skipped!.id);
      expect(loopState(h.store.pullRequests.require(pr.id)).guardian).toMatchObject({ status: 'skipped' });

      outage = null;
      h.clock.advance(8 * HOUR); // past deployWindowMs
      await guardian.tick();
      expect(runs('deploy').map((r) => r.status)).toEqual(['skipped', 'passed']);
    });

    it('skips a run whose GitHub calls fail, without a checkout or a job', async () => {
      const daily = h.store.guardianRuns.create({ projectId: h.project.id, repo: 'web', trigger: 'daily' });
      h.store.guardianRuns.update(daily.id, { status: 'passed', finished: true });
      deployedPr();
      outage = null;
      h.github.offline = true;
      const probe = vi.spyOn(h.github, 'ping');
      await guardian.tick();
      const [skipped] = runs('deploy');
      expectSkipped(skipped!.id);
      expect(h.launcher.jobs).toEqual([]);

      await guardian.tick(); // still offline: probes, starts nothing
      expect(probe).toHaveBeenCalled();
      expect(runs('deploy')).toHaveLength(1);

      h.github.offline = false;
      h.clock.advance(5 * MIN);
      await guardian.tick();
      expect(runs('deploy').map((r) => r.status)).toEqual(['skipped', 'passed']);
    });

    it('reads network errors in a failing verdict as an outage only when GitHub cannot be reached either', async () => {
      const dead = fail(true, 'GET https://shop.example.com: getaddrinfo ENOTFOUND shop.example.com');
      outage = dead;
      h.github.offline = true;
      await guardian.runNow(h.project.id, 'web');
      expectSkipped(runs()[0]!.id);

      // GitHub answers: the site itself is unreachable, which is a real, critical failure.
      h.github.offline = false;
      await guardian.runNow(h.project.id, 'web');
      expect(runs().at(-1)).toMatchObject({ status: 'failed', critical: true });
    });
  });

  it('start() ends runs a stopped server left running, and the run is retried', async () => {
    const run = h.store.guardianRuns.create({ projectId: h.project.id, repo: 'web', trigger: 'daily' });
    on();
    guardian.start();
    await guardian.stop();
    expect(h.store.guardianRuns.require(run.id)).toMatchObject({
      status: 'error',
      summary: 'the server stopped during this run',
    });
    expect(existsSync(evidence)).toBe(true);
  });
});
