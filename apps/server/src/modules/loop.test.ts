import { FakeTimers } from '@loop-engineering/ask-human';
import { FakeClock, openStore, type Store } from '@loop-engineering/core';
import {
  FakeAgentLauncher,
  FakeDeployments,
  FakeGitHub,
  FakeWorkspace,
  LoopEngine,
  ProductionGuardian,
  verdictResult,
} from '@loop-engineering/loop';
import {
  DefaultAgentCli,
  FakeGitDriver,
  FakeTmuxDriver,
  MemoryFs,
  SessionRunner,
} from '@loop-engineering/runner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, type ServerConfig } from '../config.js';
import { createServer } from '../server.js';
import { runnerFromEnv } from '../runner.js';
import { guardianConfigFromEnv, loopConfigFromEnv, loopModule, loopModuleFromEnv } from './loop.js';

const DASHBOARD = 'dashboard-token-for-tests-0001';
const serverConfig: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  dbPath: ':memory:',
  dashboardToken: DASHBOARD,
  mcpToken: 'mcp-token-for-tests-00000000001',
  corsOrigins: [],
  publicUrl: null,
};

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function boot() {
  const clock = new FakeClock('2026-10-18T09:00:00.000Z');
  const timers = new FakeTimers(clock);
  const store: Store = openStore({ clock });
  const project = store.projects.create({
    name: 'shop',
    autoMerge: false,
    repos: [{ name: 'web', path: '/src/web', remote: 'git@github.com:me/web.git', defaultBranch: 'main' }],
  });
  const fs = new MemoryFs();
  const runners: SessionRunner[] = [];
  const makeRunner = (st: Store) => {
    const r = new SessionRunner(
      {
        store: st,
        fs,
        git: new FakeGitDriver(fs),
        tmux: new FakeTmuxDriver(),
        agentCli: new DefaultAgentCli(),
        log: () => undefined,
      },
      {
        worktreesRoot: '/wt',
        serverUrl: 'http://srv',
        claudeProjectsDir: '/claude',
        env: { MCP_TOKEN: 'tok' },
      },
    );
    runners.push(r);
    return r;
  };
  const github = new FakeGitHub();
  const launcher = new FakeAgentLauncher()
    .on(
      'review',
      verdictResult({ verdict: 'approve', blocking: [], nonBlocking: [], unhandled: [], summary: 'ok' }),
    )
    .on(
      'tests',
      verdictResult({
        passed: true,
        failures: [],
        addedTests: [],
        qaNeeded: false,
        qaReason: '',
        summary: 'ok',
      }),
    );
  const guardianLauncher = new FakeAgentLauncher().on(
    'guardian',
    verdictResult({ passed: true, critical: false, failures: [] }),
  );
  const module = loopModule({
    log: () => undefined,
    createGuardian: (ctx) =>
      new ProductionGuardian({
        store: ctx.store,
        github,
        launcher: guardianLauncher,
        workspace: new FakeWorkspace(),
        questions: ctx.questions,
        timers: ctx.timers,
        log: () => undefined,
      }),
    createEngine: (ctx) =>
      new LoopEngine({
        store: ctx.store,
        runner: ctx.runner!, // the server's one runner
        questions: ctx.questions,
        github,
        launcher,
        deployments: new FakeDeployments(),
        workspace: new FakeWorkspace(),
        timers: ctx.timers,
        log: () => undefined,
      }),
  });
  const server = createServer({ config: serverConfig, store, timers, modules: [module], runner: makeRunner });
  const runner = server.ctx.runner!;
  const { url } = await server.start();
  cleanup.push(async () => {
    await server.close();
    store.close();
  });
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${url}/api${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${DASHBOARD}`, 'Content-Type': 'application/json' },
    });
  return { store, timers, runner, runners, github, module, api, project, server, guardianLauncher };
}

describe('loop server module', () => {
  it('runs the engine on the server timers and acts on an approval answered through the API at once', async () => {
    const { store, timers, runner, github, module, api, project } = await boot();
    const session = await runner.startSession(project.id, { text: 'Add a pay page' });
    github.open('me/web', { branch: session.branch });

    timers.advance(0); // the first tick
    const pr = await vi.waitFor(() => {
      const row = store.pullRequests.list()[0];
      expect(row?.stage).toBe('awaiting_approval');
      expect(module.engine()?.status().busy).toEqual([]);
      return row!;
    });
    const status = (await (await api('/loop/status')).json()) as { started: boolean; active: unknown[] };
    expect(status).toMatchObject({
      started: true,
      offlineSince: null,
      active: [{ id: pr.id, stage: 'awaiting_approval', round: 1 }],
    });

    const [question] = store.questions.list({ status: 'pending' });
    const answered = await api(`/questions/${question!.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer: 'Merge' }),
    });
    expect(answered.status).toBe(200);
    timers.advance(0); // the poke, not the 30 s interval
    await vi.waitFor(() => expect(store.pullRequests.require(pr.id).outcome).toBe('merged'));
  });

  it('runs the Production Guardian with the engine and lists its runs; repos without a productionUrl are not checked', async () => {
    const { store, timers, module, api, project, guardianLauncher } = await boot();
    timers.advance(0);
    await vi.waitFor(() => expect(module.guardian()).not.toBeNull());
    expect(guardianLauncher.jobs).toEqual([]);
    expect(store.guardianRuns.list()).toEqual([]);

    store.projects.update(project.id, {
      repos: [
        {
          name: 'web',
          path: '/src/web',
          remote: 'git@github.com:me/web.git',
          defaultBranch: 'main',
          productionUrl: 'https://shop.example.com',
        },
      ],
    });
    timers.advance(60_000); // the guardian's next tick
    await vi.waitFor(() => expect(store.guardianRuns.list()[0]?.status).toBe('passed'));

    const body = (await (await api('/guardian/runs')).json()) as {
      runs: { trigger: string; status: string }[];
    };
    expect(body.runs).toMatchObject([{ trigger: 'daily', status: 'passed' }]);
  });

  it('the server has one runner (ctx.runner) that the loop uses, and the loop starts no sessions', async () => {
    const { store, timers, runner, runners, github, module, project, server } = await boot();
    expect(runners).toHaveLength(1);
    expect(server.ctx.runner).toBe(runners[0]);
    const session = await runner.startSession(project.id, { text: 'Add a pay page' });
    github.open('me/web', { branch: session.branch });
    timers.advance(0);
    await vi.waitFor(() => {
      expect(store.pullRequests.list()[0]?.stage).toBe('awaiting_approval');
      expect(module.engine()?.status().busy).toEqual([]);
    });
    expect(store.sessions.list()).toHaveLength(1);
  });

  it('without a runner the context has none, and the env-wired loop refuses to start', async () => {
    const store = openStore();
    cleanup.push(() => store.close());
    const loop = loopModuleFromEnv({ LOOP_ENGINE: 'on', WORKTREES_ROOT: '/wt' })!;
    const server = createServer({ config: serverConfig, store, modules: [loop], log: () => undefined });
    expect(server.ctx.runner).toBeNull();
    await expect(server.start()).rejects.toThrow(/needs the server session runner/);
    await server.close();
  });

  it('answers 503 on the status route until the engine runs', async () => {
    const store = openStore();
    const module = loopModule({ createEngine: () => null as unknown as LoopEngine, log: () => undefined });
    const server = createServer({ config: serverConfig, store, modules: [module] });
    cleanup.push(() => store.close());
    const res = await server.app.request('/api/loop/status', {
      headers: { Authorization: `Bearer ${DASHBOARD}` },
    });
    expect(res.status).toBe(503);
    expect(module.engine()).toBeNull();
  });
});

describe('guardianConfigFromEnv', () => {
  it('takes the CLI from LOOP_GUARDIAN_PROVIDER and refuses anything else', () => {
    expect(guardianConfigFromEnv({})).toEqual({});
    expect(guardianConfigFromEnv({ LOOP_GUARDIAN_PROVIDER: ' OpenCode ' })).toEqual({ provider: 'opencode' });
    expect(() => guardianConfigFromEnv({ LOOP_GUARDIAN_PROVIDER: 'builder' })).toThrow(ConfigError);
  });
});

describe('loopModuleFromEnv', () => {
  it('is off unless LOOP_ENGINE=on, and then needs an absolute WORKTREES_ROOT', () => {
    expect(loopModuleFromEnv({ WORKTREES_ROOT: '/wt' })).toBeNull();
    expect(() => loopModuleFromEnv({ LOOP_ENGINE: 'on' })).toThrow(ConfigError);
    expect(() => loopModuleFromEnv({ LOOP_ENGINE: 'on', WORKTREES_ROOT: 'wt' })).toThrow(/absolute/);
    expect(loopModuleFromEnv({ LOOP_ENGINE: 'on', WORKTREES_ROOT: '/wt' })?.name).toBe('loop');
    expect(runnerFromEnv({}, serverConfig)).toBeNull();
    expect(() => runnerFromEnv({ WORKTREES_ROOT: 'rel' }, serverConfig)).toThrow(/absolute/);
    expect(typeof runnerFromEnv({ WORKTREES_ROOT: '/wt' }, serverConfig)).toBe('function');
  });

  it('reads the engine settings, with small defaults', () => {
    expect(loopConfigFromEnv({})).toEqual({
      maxConcurrentJobs: 4,
      jobTimeoutMs: 30 * 60_000,
      maxRounds: 5,
      tickIntervalMs: 30_000,
      jobModel: null,
      stageProviders: { review: 'claude', tests: 'opencode', qa: 'claude', conflict: 'claude' },
    });
    expect(loopConfigFromEnv({ LOOP_TESTS_PROVIDER: 'Builder' }).stageProviders?.tests).toBe('builder');
    expect(() => loopConfigFromEnv({ LOOP_QA_PROVIDER: 'gpt' })).toThrow(/LOOP_QA_PROVIDER must be one of/);
    expect(loopConfigFromEnv({ LOOP_MAX_JOBS: '1', LOOP_JOB_MODEL: 'sonnet' })).toMatchObject({
      maxConcurrentJobs: 1,
      jobModel: 'sonnet',
    });
    expect(() => loopConfigFromEnv({ LOOP_MAX_JOBS: '0', LOOP_TICK_SECONDS: 'x' })).toThrow(
      /LOOP_MAX_JOBS must be a positive integer[\s\S]*LOOP_TICK_SECONDS/,
    );
  });
});
