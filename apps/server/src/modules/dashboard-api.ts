import { dirname, join } from 'node:path';
import { HISTORY_SEARCH_LIMITS, searchHistory, sessionTranscript } from '@loop-engineering/history';
import {
  checkFolderProjectPath,
  checkReposAgainstFolders,
  HISTORY_KINDS,
  secretValues,
  PERMISSION_MODES,
  PR_STAGES,
  SESSION_STATUSES,
  ValidationError,
  type LoopMetrics,
  type Project,
  type PullRequest,
  type Request,
  type Session,
  type Subagent,
} from '@loop-engineering/core';
import { routerProjectId } from '@loop-engineering/router';
import { Hono, type Context } from 'hono';
import * as z from 'zod';
import type { ServerContext, ServerModule } from '../context.js';
import { REPO_ROOT } from '../env.js';

/**
 * The dashboard's read/write API, mounted under the authenticated /api (DASHBOARD_TOKEN):
 *
 *   GET    /projects                         { projects }
 *   POST   /projects                         git project: { name, kind?: 'git', repos?, envFiles?, autoMerge?,
 *                                              markedForDirectInput?, permissionMode? }
 *                                            folder project: { name, kind: 'folder', folderPath,
 *                                              markedForDirectInput?, permissionMode?, autoMerge? (kept,
 *                                              unused: no PRs), allowGitFolder?, allowOutsideHome? }
 *                                            -> 201 { project }; 409 if the name is taken. The folder
 *                                            must exist and pass checkFolderProjectPath (no /, no home
 *                                            folder, clear of WORKTREES_ROOT and of other projects, no
 *                                            git repo root unless allowGitFolder); its canonical path is stored.
 *   GET    /projects/:id                     { project }
 *   PATCH  /projects/:id                     any of the git POST fields except kind -> { project };
 *                                            kind and folderPath can never change
 *   DELETE /projects/:id                     { deleted: true }; 409 while a session is not ended or a PR
 *                                            is open (the delete cascades to sessions, PRs, history)
 *   The router's reserved project is left out of the lists; PATCH/DELETE on it get 409, a task for it 400.
 *   POST   /sessions/:id/end                 { force? } -> { session }: the runner's end(); 400 on uncommitted
 *                                            changes in a git worktree unless force: true; a folder
 *                                            session's files are never touched; 503 without a runner;
 *                                            409 for an imported session (source "import")
 *   GET    /sessions/:id/transcript           { transcript: { createdAt, text } | null }: the latest
 *                                            stored transcript of a past session (the View button
 *                                            of a finished row), redacted like search results
 *   GET    /tree[?status=active,paused]      { projects: [{ ...project, sessions: [{ ...session,
 *                                              pendingQuestions, subagents: [...] }] }] }, sessions
 *                                            newest first; session.source "import" marks imported ones
 *   GET    /requests[?projectId=N|none&sessionId=N]   { requests }, newest first
 *   POST   /requests                         { text, projectId? | sessionId? } -> 201 { request } (source
 *                                            "dashboard"); sessionId addresses one open session (the
 *                                            request takes its project); 409 once it has ended
 *   GET    /prs[?projectId=&stage=a,b&open=true|false] { pullRequests: [{ ...pr, request, metrics }] }
 *   GET    /prs/:id                          { pullRequest } (same shape as a list item)
 *   GET    /prs/:id/metrics                  { metrics }
 *   GET    /metrics[?projectId=]             { metrics, totals }
 *   GET    /history?q=[&projectId=&kind=&limit=]  { results: [{ entryId, sessionId, kind, createdAt,
 *                                              snippet }] }, best match first; every word of q must match
 *   GET    /settings                         { settings }
 *   PATCH  /settings                         any of { sessionModel, fallbackModel, telegramAllowlist,
 *                                              claudeEnabled, opencodeEnabled, opencodeBackupModels };
 *                                              400 turning both CLIs off
 *
 * Every body is a strict JSON object: unknown keys, wrong types and out-of-range values are 400s.
 */
export interface DashboardApiOptions {
  /**
   * Folders no folder project may overlap. Default: the runner's worktree and state folders, or
   * WORKTREES_ROOT (and its .loop-runner) when there is no runner, plus LOOP_JOBS_ROOT if set.
   */
  protectedRoots?: string[];
  /** Default os.homedir(). */
  home?: string;
}

export function dashboardApi(options: DashboardApiOptions = {}): ServerModule {
  return { name: 'dashboard-api', api: (api, ctx) => api.route('/', dashboardRoutes(ctx, options)) };
}

/**
 * Always protected, whatever the options: the server's own repository (it holds .env with the
 * tokens) and the database folder.
 */
function serverRoots(ctx: ServerContext): string[] {
  const roots = [REPO_ROOT];
  if (ctx.config.dbPath !== ':memory:' && ctx.config.dbPath.startsWith('/'))
    roots.push(dirname(ctx.config.dbPath));
  return roots;
}

function defaultProtectedRoots(ctx: ServerContext): string[] {
  const env = process.env;
  const roots = ctx.runner?.protectedRoots() ?? [];
  const worktrees = env.WORKTREES_ROOT?.trim();
  if (worktrees) roots.push(worktrees, join(worktrees, '.loop-runner'));
  const jobs = env.LOOP_JOBS_ROOT?.trim();
  if (jobs) roots.push(jobs);
  return roots.filter((r) => r.startsWith('/'));
}

const LIMITS = { name: 100, path: 1000, remote: 500, branch: 200, model: 200, request: 4000, allowlist: 200 };

const id = z.coerce.number().int().positive();
const text = (max: number) => z.string().trim().min(1).max(max);
const absolutePath = text(LIMITS.path).refine((p) => p.startsWith('/'), 'must be an absolute path');
// Env files are copied into a worktree: the target must stay inside it.
const relativePath = text(LIMITS.path).refine(
  (p) => !p.startsWith('/') && !p.split(/[\\/]/).includes('..'),
  'must be a relative path inside the worktree (no leading / or ..)',
);
const repo = z.strictObject({
  name: text(LIMITS.name),
  path: absolutePath,
  remote: text(LIMITS.remote),
  defaultBranch: text(LIMITS.branch),
  vercelProject: text(LIMITS.name).optional(),
  // The live site the Production Guardian checks; without it the repo is not guarded.
  productionUrl: text(LIMITS.remote)
    .refine((u) => /^https:\/\/[^\s/]+/.test(u), 'must be an https URL')
    .optional(),
});
const envFile = z.strictObject({ repo: text(LIMITS.name), source: absolutePath, target: relativePath });
const projectFields = {
  name: text(LIMITS.name),
  repos: z.array(repo).max(20),
  envFiles: z.array(envFile).max(50),
  autoMerge: z.boolean(),
  markedForDirectInput: z.boolean(),
  permissionMode: z.enum(PERMISSION_MODES).refine((m) => m !== 'bypassPermissions', {
    message: 'bypassPermissions can only be set locally, not from the dashboard',
  }),
};
const newProject = z.strictObject({
  ...projectFields,
  kind: z.literal('git').optional(),
  repos: projectFields.repos.optional(),
  envFiles: projectFields.envFiles.optional(),
  autoMerge: projectFields.autoMerge.optional(),
  markedForDirectInput: projectFields.markedForDirectInput.optional(),
  permissionMode: projectFields.permissionMode.optional(),
});
const newFolderProject = z.strictObject({
  name: projectFields.name,
  kind: z.literal('folder'),
  folderPath: absolutePath,
  autoMerge: projectFields.autoMerge.optional(),
  markedForDirectInput: projectFields.markedForDirectInput.optional(),
  permissionMode: projectFields.permissionMode.optional(),
  allowGitFolder: z.boolean().optional(),
  allowOutsideHome: z.boolean().optional(),
});
const endSession = z.strictObject({ force: z.boolean().optional() });
const nonEmpty = <T extends object>(o: T) => Object.keys(o).length > 0;
const projectPatch = z.strictObject(projectFields).partial().refine(nonEmpty, 'nothing to update');
const settingsPatch = z
  .strictObject({
    sessionModel: text(LIMITS.model),
    fallbackModel: text(LIMITS.model),
    telegramAllowlist: z
      .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
      .max(LIMITS.allowlist),
    claudeEnabled: z.boolean(),
    opencodeEnabled: z.boolean(),
    opencodeBackupModels: z.array(text(200)).max(10),
  })
  .partial()
  .refine(nonEmpty, 'nothing to update');
const newRequest = z.strictObject({
  text: text(LIMITS.request),
  projectId: id.nullable().optional(),
  sessionId: id.optional(),
});

const list = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()))
    .pipe(z.array(z.enum(values)));
const treeQuery = z.object({ status: list(SESSION_STATUSES).optional() });
const requestQuery = z.object({
  projectId: z.union([z.literal('none').transform(() => null), id]).optional(),
  sessionId: id.optional(),
});
const prQuery = z.object({
  projectId: id.optional(),
  stage: list(PR_STAGES).optional(),
  open: z.enum(['true', 'false']).optional(),
});
const metricsQuery = z.object({ projectId: id.optional() });
const historyQuery = z.object({
  q: text(HISTORY_SEARCH_LIMITS.query),
  projectId: id.optional(),
  kind: z.enum(HISTORY_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(HISTORY_SEARCH_LIMITS.maxResults).optional(),
});

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError(z.prettifyError(result.error));
  return result.data;
}

/** Undefined keys out: the store treats a present-but-undefined field like a missing one anyway. */
function defined<T extends object>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;
}

async function body(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ValidationError('body must be a JSON object');
  }
}

export interface TreeSession extends Session {
  /** Questions from this session (or its subagents) still waiting for the human. */
  pendingQuestions: number;
  subagents: Subagent[];
}
export interface TreeProject extends Project {
  sessions: TreeSession[];
}
export interface PullRequestView extends PullRequest {
  request: Request | null;
  metrics: LoopMetrics;
}

/**
 * The one place the dashboard creates a request (a new task). Through ctx.requests, not the store,
 * so request.created is emitted and the router sees dashboard tasks. projectId null leaves the
 * project to the router.
 */
function createDashboardRequest(
  ctx: ServerContext,
  input: { text: string; projectId: number | null; targetSessionId?: number },
): Request {
  return ctx.requests.create({ ...input, source: 'dashboard' });
}

export function dashboardRoutes(ctx: ServerContext, options: DashboardApiOptions = {}): Hono {
  const { store } = ctx;
  const api = new Hono();

  // The router's reserved project (holds routing questions): hidden from the lists, and no task,
  // edit or delete may target it.
  const isReserved = (projectId: number) => projectId === routerProjectId(store);
  const reserved = (c: Context) => c.json({ error: 'that project is reserved for routing questions' }, 409);
  const visibleProjects = () => store.projects.list().filter((p) => !isReserved(p.id));

  const nameTaken = (name: string, except?: number) => {
    const existing = store.projects.getByName(name);
    return existing !== undefined && existing.id !== except;
  };

  api.get('/projects', (c) => c.json({ projects: visibleProjects() }));

  api.post('/projects', async (c) => {
    const raw = await body(c);
    const isFolder = typeof raw === 'object' && raw !== null && (raw as { kind?: unknown }).kind === 'folder';
    if (!isFolder) {
      const input = parse(newProject, raw);
      if (nameTaken(input.name)) return c.json({ error: `a project named "${input.name}" exists` }, 409);
      checkReposAgainstFolders(input.repos ?? [], store.projects.list());
      return c.json({ project: store.projects.create(defined(input)) }, 201);
    }
    const { allowGitFolder, allowOutsideHome, folderPath, ...input } = parse(newFolderProject, raw);
    if (nameTaken(input.name)) return c.json({ error: `a project named "${input.name}" exists` }, 409);
    const canonical = checkFolderProjectPath(folderPath, {
      protectedRoots: [...(options.protectedRoots ?? defaultProtectedRoots(ctx)), ...serverRoots(ctx)],
      ...(options.home ? { home: options.home } : {}),
      ...(process.env.CLAUDE_CONFIG_DIR ? { claudeConfigDir: process.env.CLAUDE_CONFIG_DIR } : {}),
      projects: store.projects.list(),
      allowGitFolder: allowGitFolder ?? false,
      allowOutsideHome: allowOutsideHome ?? false,
    });
    return c.json({ project: store.projects.create({ ...defined(input), folderPath: canonical }) }, 201);
  });

  api.get('/projects/:id', (c) => c.json({ project: store.projects.require(parse(id, c.req.param('id'))) }));

  api.patch('/projects/:id', async (c) => {
    const projectId = parse(id, c.req.param('id'));
    const raw = await body(c);
    for (const fixed of ['kind', 'folderPath']) {
      if (typeof raw === 'object' && raw !== null && fixed in raw) {
        throw new ValidationError(`a project's ${fixed} cannot be changed`);
      }
    }
    const patch = parse(projectPatch, raw);
    store.projects.require(projectId);
    if (isReserved(projectId)) return reserved(c);
    if (patch.name !== undefined && nameTaken(patch.name, projectId)) {
      return c.json({ error: `a project named "${patch.name}" exists` }, 409);
    }
    if (patch.repos) checkReposAgainstFolders(patch.repos, store.projects.list(), projectId);
    return c.json({ project: store.projects.update(projectId, defined(patch)) });
  });

  api.delete('/projects/:id', (c) => {
    const projectId = parse(id, c.req.param('id'));
    store.projects.require(projectId);
    if (isReserved(projectId)) return reserved(c);
    // The delete cascades to sessions, questions, PRs, metrics and history: never under live work.
    const live = store.sessions.list({ projectId, status: ['active', 'paused'] });
    const open = store.pullRequests.list({ projectId, open: true });
    if (live.length > 0 || open.length > 0) {
      const what = [
        live.length > 0 && `${live.length} session(s) not ended (${live.map((s) => s.id).join(', ')})`,
        open.length > 0 &&
          `${open.length} open PR(s) (${open.map((p) => `${p.repo}#${p.number}`).join(', ')})`,
      ].filter(Boolean);
      return c.json({ error: `project ${projectId} still has ${what.join(' and ')}; end them first` }, 409);
    }
    store.projects.delete(projectId);
    return c.json({ deleted: true });
  });

  // Ends a session through the runner: stops its agent and removes its worktrees and runner state.
  // A folder session's files are never touched. A git session with uncommitted changes is refused
  // unless the body says { force: true } explicitly (those changes are then lost).
  api.post('/sessions/:id/end', async (c) => {
    const sessionId = parse(id, c.req.param('id'));
    const { force } = parse(endSession, await body(c));
    const session = store.sessions.require(sessionId);
    if (isReserved(session.projectId)) return reserved(c);
    if (session.source === 'import')
      return c.json({ error: 'an imported past conversation has already ended' }, 409);
    if (!ctx.runner)
      return c.json({ error: 'no session runner on this server (WORKTREES_ROOT is not set)' }, 503);
    return c.json({ session: await ctx.runner.end(sessionId, { force: force ?? false }) });
  });

  // A fixed number of queries whatever the size: sessions, their subagents, pending questions.
  api.get('/tree', (c) => {
    const { status } = parse(treeQuery, c.req.query());
    const pending = new Map<number, number>();
    for (const q of store.questions.listPending())
      pending.set(q.sessionId, (pending.get(q.sessionId) ?? 0) + 1);
    const sessions = store.sessions.list(status ? { status } : {});
    const subagents = new Map<number, Subagent[]>();
    // In chunks, so the IN (...) list stays far below SQLite's bound-parameter limit.
    for (let i = 0; i < sessions.length; i += 500) {
      const ids = sessions.slice(i, i + 500).map((s) => s.id);
      for (const sub of store.subagents.list({ sessionId: ids })) {
        const list = subagents.get(sub.sessionId) ?? [];
        list.push(sub);
        subagents.set(sub.sessionId, list);
      }
    }
    const byProject = new Map<number, TreeSession[]>();
    for (const s of sessions) {
      const list = byProject.get(s.projectId) ?? [];
      list.push({ ...s, pendingQuestions: pending.get(s.id) ?? 0, subagents: subagents.get(s.id) ?? [] });
      byProject.set(s.projectId, list);
    }
    const projects: TreeProject[] = visibleProjects().map((project) => ({
      ...project,
      sessions: byProject.get(project.id) ?? [],
    }));
    return c.json({ projects });
  });

  api.get('/requests', (c) => {
    const { projectId, sessionId } = parse(requestQuery, c.req.query());
    const requests = store.requests.list(defined({ projectId, sessionId }));
    requests.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id); // newest first
    return c.json({ requests });
  });

  api.post('/requests', async (c) => {
    const input = parse(newRequest, await body(c));
    if (input.sessionId !== undefined) {
      const session = store.sessions.require(input.sessionId);
      if (input.projectId != null && input.projectId !== session.projectId)
        throw new ValidationError(`session ${session.id} is not in project ${input.projectId}`);
      if (isReserved(session.projectId)) return reserved(c);
      if (session.status === 'ended')
        return c.json({ error: 'that session has ended; start a new session in its project instead' }, 409);
      const request = createDashboardRequest(ctx, {
        text: input.text,
        projectId: session.projectId,
        targetSessionId: session.id,
      });
      return c.json({ request }, 201);
    }
    if (input.projectId != null && isReserved(input.projectId)) {
      return c.json({ error: 'tasks cannot target the project reserved for routing questions' }, 400);
    }
    const request = createDashboardRequest(ctx, { text: input.text, projectId: input.projectId ?? null });
    return c.json({ request }, 201);
  });

  const view = (pr: PullRequest): PullRequestView => ({
    ...pr,
    request: pr.requestId === null ? null : (store.requests.get(pr.requestId) ?? null),
    metrics: store.metrics.get(pr.id),
  });

  api.get('/prs', (c) => {
    const { projectId, stage, open } = parse(prQuery, c.req.query());
    const prs = store.pullRequests.list(
      defined({ projectId, stage, open: open === undefined ? undefined : open === 'true' }),
    );
    // Most recently moved first: that is what the pipeline view shows on top.
    prs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id);
    return c.json({ pullRequests: prs.map(view) });
  });

  api.get('/prs/:id', (c) =>
    c.json({ pullRequest: view(store.pullRequests.require(parse(id, c.req.param('id')))) }),
  );

  api.get('/prs/:id/metrics', (c) => c.json({ metrics: store.metrics.get(parse(id, c.req.param('id'))) }));

  api.get('/metrics', (c) => {
    const metrics = store.metrics.list(defined(parse(metricsQuery, c.req.query())));
    const totals = metrics.reduce(
      (t, m) => ({
        costUsd: t.costUsd + m.costUsd,
        tokensIn: t.tokensIn + m.tokensIn,
        tokensOut: t.tokensOut + m.tokensOut,
        rounds: t.rounds + m.rounds,
        failures: t.failures + m.failures,
        prs: t.prs + 1,
      }),
      { costUsd: 0, tokensIn: 0, tokensOut: 0, rounds: 0, failures: 0, prs: 0 },
    );
    return c.json({ metrics, totals });
  });

  // The body of a finished row's View button: the session's latest stored transcript, or null when
  // nothing is stored yet (OpenCode sessions have no Claude transcript; imports store one at import).
  api.get('/sessions/:id/transcript', async (c) => {
    const sessionId = parse(id, c.req.param('id'));
    store.sessions.require(sessionId);
    // Redacted on read too: entries written by other sources never hold a secret here either.
    return c.json({
      transcript: await sessionTranscript(store, sessionId, { secrets: secretValues(process.env) }),
    });
  });

  api.get('/history', async (c) => {
    const { q, projectId, kind, limit } = parse(historyQuery, c.req.query());
    if (projectId !== undefined) store.projects.require(projectId);
    const query = defined({ query: q, projectId, kind, limit });
    // Redacted on read too: entries written by the loop or router may hold a token (e.g. a remote URL).
    return c.json({ results: await searchHistory(store, query, { secrets: secretValues(process.env) }) });
  });

  api.get('/settings', (c) => c.json({ settings: store.settings.get() }));

  api.patch('/settings', async (c) => {
    const patch = parse(settingsPatch, await body(c));
    return c.json({ settings: store.settings.update(defined(patch)) });
  });

  return api;
}
