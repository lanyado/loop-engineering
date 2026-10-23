import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GuardianArea } from '@loop-engineering/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductionGuardian, type GuardianConfig } from './guardian.js';
import { verdictResult } from './fakes.js';
import type { AgentJob, AgentJobResult } from './ports.js';
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

  beforeEach(() => {
    h = new Harness({ productionUrl: URL, vercelProject: 'shop' });
    evidence = mkdtempSync(join(tmpdir(), 'guardian-'));
    build();
  });
  afterEach(() => {
    h.close();
    rmSync(evidence, { recursive: true, force: true });
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
