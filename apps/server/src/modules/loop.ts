import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CliAgentLauncher,
  Connectivity,
  GhCli,
  GhDeployments,
  GitWorkspace,
  jobLogFile,
  LoopEngine,
  ProductionGuardian,
  type GuardianConfig,
  type LoopConfig,
  type LoopDeps,
  type StageProvider,
} from '@loop-engineering/loop';
import { shellQuote } from '@loop-engineering/runner';
import { ConfigError } from '../config.js';
import type { ServerContext, ServerModule } from '../context.js';
import { macCommandOpener, type CommandOpener } from './terminal.js';

/** Prints a job log readably as it grows (apps/server/scripts, next to src/ and dist/). */
const FOLLOW_SCRIPT = fileURLToPath(new URL('../../scripts/follow-job.mjs', import.meta.url));
const STAGES = new Set(['review', 'tests', 'qa']);

export interface LoopModuleOptions {
  /** Builds the engine once the server context (store, questions, requests, runner) exists. */
  createEngine(ctx: ServerContext): LoopEngine;
  /** Builds the Production Guardian, started and stopped with the engine. Omit for none. */
  createGuardian?(ctx: ServerContext): ProductionGuardian;
  log?: (message: string) => void;
  /** Opens a stage terminal. Default: macCommandOpener(). */
  openCommand?: CommandOpener;
}

export type LoopModule = ServerModule & {
  engine(): LoopEngine | null;
  guardian(): ProductionGuardian | null;
};

/**
 * The PR loop as a server module. start() builds the engine and starts ticking (it never waits on
 * the network: the first tick runs in the background). An answered question pokes the engine so an
 * approval or escalation answer is acted on at once. GET /api/loop/status shows what it is doing.
 */
export function loopModule(options: LoopModuleOptions): LoopModule {
  const log = options.log ?? console.log;
  const openCommand = options.openCommand ?? macCommandOpener();
  let engine: LoopEngine | null = null;
  let guardian: ProductionGuardian | null = null;
  let unsubscribe: (() => void) | null = null;
  return {
    name: 'loop',
    engine: () => engine,
    guardian: () => guardian,

    api(api, ctx) {
      api.get('/loop/status', (c) =>
        engine ? c.json(engine.status()) : c.json({ error: 'the PR loop is not running' }, 503),
      );
      // The Production Guardian's runs, newest first: GET /api/guardian/runs[?projectId=&limit=]
      api.get('/guardian/runs', (c) => {
        const projectId = c.req.query('projectId');
        const limit = Math.min(Number(c.req.query('limit')) || 50, 200);
        const runs = ctx.store.guardianRuns.list(projectId ? { projectId: Number(projectId) } : {}, limit);
        return c.json({ runs: runs.reverse() });
      });
      // A Terminal window following a PR stage's job log (review, tests or QA), for the dashboard.
      api.post('/prs/:id/terminal', async (c) => {
        const logsDir = engine?.config.logsDir;
        if (!logsDir) return c.json({ error: 'the PR loop keeps no job logs here' }, 503);
        const id = Number(c.req.param('id'));
        const body = (await c.req.json().catch(() => ({}))) as { stage?: unknown };
        const stage = typeof body.stage === 'string' && STAGES.has(body.stage) ? body.stage : null;
        if (!stage) return c.json({ error: 'stage must be review, tests or qa' }, 400);
        if (!Number.isInteger(id) || !ctx.store.pullRequests.get(id))
          return c.json({ error: 'no such PR' }, 404);
        const file = jobLogFile(logsDir, id, stage as 'review' | 'tests' | 'qa');
        if (!existsSync(file)) return c.json({ error: 'this stage has not run yet' }, 409);
        try {
          await openCommand(
            `pr${id}-${stage}`,
            `${shellQuote(process.execPath)} ${shellQuote(FOLLOW_SCRIPT)} ${shellQuote(file)}`,
          );
        } catch (error) {
          return c.json({ error: `could not open a terminal: ${String(error)}` }, 500);
        }
        return c.json({ opened: true });
      });
    },

    start(ctx) {
      engine = options.createEngine(ctx);
      const current = engine;
      unsubscribe = ctx.bus.on('question.resolved', () => current.poke());
      engine.start();
      guardian = options.createGuardian?.(ctx) ?? null;
      guardian?.start();
      log(`[loop] PR loop started (at most ${engine.config.maxConcurrentJobs} agent jobs at once)`);
    },

    async stop() {
      unsubscribe?.();
      unsubscribe = null;
      await guardian?.stop();
      guardian = null;
      await engine?.stop();
      engine = null;
    },
  };
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number, problems: string[]): number {
  const text = env[name]?.trim();
  if (!text) return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1)
    problems.push(`${name} must be a positive integer, got "${text}"`);
  return value;
}

const STAGE_PROVIDERS = ['claude', 'opencode', 'builder'] as const;
const PROVIDERS = ['claude', 'opencode'] as const;

function stageProvider(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: StageProvider,
  problems: string[],
): StageProvider {
  const text = env[name]?.trim().toLowerCase();
  if (!text) return fallback;
  if ((STAGE_PROVIDERS as readonly string[]).includes(text)) return text as StageProvider;
  problems.push(`${name} must be one of ${STAGE_PROVIDERS.join(', ')}, got "${text}"`);
  return fallback;
}

/** Engine settings from LOOP_* variables (see .env.example). Throws ConfigError listing every problem. */
export function loopConfigFromEnv(env: NodeJS.ProcessEnv): Partial<LoopConfig> {
  const problems: string[] = [];
  const config: Partial<LoopConfig> = {
    maxConcurrentJobs: positiveInt(env, 'LOOP_MAX_JOBS', 4, problems),
    jobTimeoutMs: positiveInt(env, 'LOOP_JOB_TIMEOUT_MINUTES', 30, problems) * 60_000,
    maxRounds: positiveInt(env, 'LOOP_MAX_ROUNDS', 5, problems),
    tickIntervalMs: positiveInt(env, 'LOOP_TICK_SECONDS', 30, problems) * 1000,
    jobModel: env.LOOP_JOB_MODEL?.trim() || null,
    // Claude where a weak answer gets through (review gates the merge, QA drives a browser for long);
    // free models where the answer is checkable (tests report exit codes, CI reruns them).
    stageProviders: {
      review: stageProvider(env, 'LOOP_REVIEW_PROVIDER', 'claude', problems),
      tests: stageProvider(env, 'LOOP_TESTS_PROVIDER', 'opencode', problems),
      qa: stageProvider(env, 'LOOP_QA_PROVIDER', 'claude', problems),
      conflict: stageProvider(env, 'LOOP_CONFLICT_PROVIDER', 'claude', problems),
    },
  };
  if (problems.length > 0) throw new ConfigError(`Invalid PR loop config:\n- ${problems.join('\n- ')}`);
  return config;
}

/** The Production Guardian's settings from LOOP_GUARDIAN_PROVIDER (claude or opencode). */
export function guardianConfigFromEnv(env: NodeJS.ProcessEnv): Partial<GuardianConfig> {
  const text = env.LOOP_GUARDIAN_PROVIDER?.trim().toLowerCase();
  if (!text) return {};
  if ((PROVIDERS as readonly string[]).includes(text))
    return { provider: text as (typeof PROVIDERS)[number] };
  throw new ConfigError(`LOOP_GUARDIAN_PROVIDER must be one of ${PROVIDERS.join(', ')}, got "${text}"`);
}

/**
 * The real wiring over the server's one runner (ctx.runner): gh, the claude / opencode CLIs and git
 * worktrees for jobs. Null (the loop is off) unless LOOP_ENGINE=on: once on, it reviews, merges and
 * reverts real PRs, so it is opt-in. It never starts sessions: the fix request goes through
 * ctx.requests (request.created) and the router starts its session.
 */
export function loopModuleFromEnv(env: NodeJS.ProcessEnv, deps: Partial<LoopDeps> = {}): LoopModule | null {
  if (env.LOOP_ENGINE?.trim() !== 'on') return null;
  const worktreesRoot = env.WORKTREES_ROOT?.trim();
  if (!worktreesRoot) throw new ConfigError('LOOP_ENGINE=on needs WORKTREES_ROOT (where sessions run)');
  const jobsRoot = env.LOOP_JOBS_ROOT?.trim() || join(worktreesRoot, '.loop-jobs');
  if (!isAbsolute(worktreesRoot) || !isAbsolute(jobsRoot)) {
    throw new ConfigError('WORKTREES_ROOT and LOOP_JOBS_ROOT must be absolute paths');
  }
  const config = { ...loopConfigFromEnv(env), logsDir: join(jobsRoot, 'logs') };
  const guardianConfig = { ...guardianConfigFromEnv(env), evidenceDir: join(jobsRoot, 'guardian') };
  // One connectivity state for the engine and the guardian: they pause and resume together.
  let connectivity: Connectivity | undefined;
  const sharedConnectivity = (ctx: ServerContext) =>
    (connectivity ??= new Connectivity(deps.github ?? new GhCli(), ctx.store.clock, (m) =>
      console.log(`[loop] ${m}`),
    ));
  return loopModule({
    createGuardian(ctx) {
      return new ProductionGuardian(
        {
          store: ctx.store,
          github: new GhCli(),
          launcher: new CliAgentLauncher(),
          workspace: new GitWorkspace(jobsRoot),
          questions: ctx.questions,
          timers: ctx.timers,
          createRequest: (input) => ctx.requests.create({ ...input, source: 'dashboard' }),
          connectivity: sharedConnectivity(ctx),
          ...(deps.github ? { github: deps.github } : {}),
          ...(deps.launcher ? { launcher: deps.launcher } : {}),
          ...(deps.workspace ? { workspace: deps.workspace } : {}),
        },
        guardianConfig,
      );
    },
    createEngine(ctx) {
      if (!ctx.runner) throw new Error('the PR loop needs the server session runner (WORKTREES_ROOT)');
      return new LoopEngine(
        {
          store: ctx.store,
          runner: ctx.runner,
          questions: ctx.questions,
          github: new GhCli(),
          launcher: new CliAgentLauncher(),
          deployments: new GhDeployments(),
          workspace: new GitWorkspace(jobsRoot),
          timers: ctx.timers,
          // The one place the loop records a request: the server's RequestService (request.created).
          createRequest: (input) => ctx.requests.create({ ...input, source: 'dashboard' }),
          connectivity: sharedConnectivity(ctx),
          ...deps,
        },
        config,
      );
    },
  });
}
