import { isoNow, type Clock } from '../clock.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { parseJson, toJson, updateById, where, type Db } from '../sql.js';
import {
  RIGOR_LEVELS,
  isAgentId,
  isModelName,
  MAX_AGENT_MODELS,
  type AgentModels,
  type Effort,
  type PauseReason,
  type Provider,
  type Rigor,
  type RigorSource,
  type Session,
  type SessionSource,
  type SessionStatus,
  type Worktree,
} from '../types.js';
import type { ProjectRepo } from './projects.js';

export interface NewSession {
  projectId: number;
  title: string;
  model: string;
  branch: string;
  status?: SessionStatus;
  /** Only with status "paused"; defaults to "manual" there. */
  pauseReason?: PauseReason;
  provider?: Provider;
  effort?: Effort | null;
  tmuxTarget?: string | null;
  agentSessionId?: string | null;
  worktrees?: Worktree[];
}

/** A past Claude Code conversation, stored as an ended session with source "import". */
export interface ImportedSession {
  projectId: number;
  title: string;
  model: string;
  agentSessionId: string;
  /** First and last message times of the conversation. */
  createdAt: string;
  endedAt: string;
}

export type SessionPatch = Partial<
  Pick<
    Session,
    | 'title'
    | 'status'
    | 'provider'
    | 'model'
    | 'effort'
    | 'tmuxTarget'
    | 'agentSessionId'
    | 'branch'
    | 'worktrees'
    | 'rigor'
  > & { pauseReason: PauseReason }
>;

/** The Planner's model picks for a task (agent id -> model) and its one-line reason. */
export interface ModelPicks {
  models: Record<string, string>;
  reason: string | null;
}

function checkAgentModel(agent: string, model: string): void {
  if (!isAgentId(agent)) throw new ValidationError(`unknown agent "${agent}"`);
  if (!isModelName(model)) {
    throw new ValidationError(
      `"${model}" is not a model name: letters, digits and . - _ / : (80 at most), not starting with a dash`,
    );
  }
}

export interface SessionFilter {
  projectId?: number;
  status?: SessionStatus | SessionStatus[];
  source?: SessionSource;
}

interface SessionRow {
  id: number;
  project_id: number;
  title: string;
  status: SessionStatus;
  pause_reason: PauseReason | null;
  provider: Provider;
  model: string;
  effort: Effort | null;
  tmux_target: string | null;
  agent_session_id: string | null;
  branch: string;
  worktrees: string;
  source: SessionSource;
  rigor: Rigor;
  rigor_source: RigorSource;
  rigor_reason: string | null;
  models: string | null;
  models_reason: string | null;
  plan: string | null;
  planned_at: string | null;
  created_at: string;
  ended_at: string | null;
}

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  status: r.status,
  pauseReason: r.pause_reason,
  provider: r.provider,
  model: r.model,
  effort: r.effort,
  tmuxTarget: r.tmux_target,
  agentSessionId: r.agent_session_id,
  branch: r.branch,
  worktrees: parseJson<Worktree[]>(r.worktrees),
  source: r.source,
  rigor: r.rigor,
  rigorSource: r.rigor_source,
  rigorReason: r.rigor_reason,
  models: r.models === null ? {} : parseJson<AgentModels>(r.models),
  modelsReason: r.models_reason,
  plan: r.plan,
  plannedAt: r.planned_at,
  createdAt: r.created_at,
  endedAt: r.ended_at,
});

function pauseReasonFor(status: SessionStatus, reason: PauseReason | undefined): PauseReason | null {
  if (status === 'paused') return reason ?? 'manual';
  if (reason !== undefined) throw new ValidationError('pauseReason is only allowed on a paused session');
  return null;
}

export class SessionRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly projects: ProjectRepo,
  ) {}

  create(input: NewSession): Session {
    const worktrees = input.worktrees ?? [];
    this.validateWorktrees(input.projectId, worktrees);
    const status = input.status ?? 'active';
    const pauseReason = pauseReasonFor(status, input.pauseReason);
    const now = isoNow(this.clock);
    const info = this.db
      .prepare(
        `INSERT INTO sessions
           (project_id, title, status, pause_reason, provider, model, effort, tmux_target, agent_session_id,
            branch, worktrees, created_at, ended_at)
         VALUES
           (@projectId, @title, @status, @pauseReason, @provider, @model, @effort, @tmuxTarget, @agentSessionId,
            @branch, @worktrees, @now, @endedAt)`,
      )
      .run({
        projectId: input.projectId,
        title: input.title,
        status,
        pauseReason,
        provider: input.provider ?? 'claude',
        model: input.model,
        effort: input.effort ?? null,
        tmuxTarget: input.tmuxTarget ?? null,
        agentSessionId: input.agentSessionId ?? null,
        branch: input.branch,
        worktrees: JSON.stringify(worktrees),
        now,
        endedAt: status === 'ended' ? now : null,
      });
    return this.require(Number(info.lastInsertRowid));
  }

  /**
   * Stores a past conversation as an ended, imported session: no branch, worktrees or tmux target.
   * Returns null, changing nothing, when this project already has it imported.
   */
  importEnded(input: ImportedSession): Session | null {
    this.projects.require(input.projectId);
    const created = Date.parse(input.createdAt);
    const ended = Date.parse(input.endedAt);
    if (Number.isNaN(created) || Number.isNaN(ended))
      throw new ValidationError('createdAt and endedAt must be ISO times');
    if (ended < created) throw new ValidationError('endedAt is before createdAt');
    if (input.agentSessionId.trim() === '') throw new ValidationError('agentSessionId must not be empty');
    const info = this.db
      .prepare(
        `INSERT INTO sessions
           (project_id, title, status, provider, model, agent_session_id, branch, worktrees, source,
            created_at, ended_at)
         VALUES (@projectId, @title, 'ended', 'claude', @model, @agentSessionId, '', '[]', 'import',
            @createdAt, @endedAt)
         ON CONFLICT (project_id, agent_session_id) WHERE source = 'import' DO NOTHING`,
      )
      .run({
        projectId: input.projectId,
        title: input.title,
        model: input.model,
        agentSessionId: input.agentSessionId,
        createdAt: new Date(created).toISOString(),
        endedAt: new Date(ended).toISOString(),
      });
    return info.changes === 0 ? null : this.require(Number(info.lastInsertRowid));
  }

  /** Sessions of `projectId` (any source) holding this conversation id. */
  findByAgentSessionId(agentSessionId: string, projectId?: number): Session[] {
    const { clause, params } = where({ agent_session_id: agentSessionId, project_id: projectId });
    return this.db
      .prepare<[Record<string, unknown>], SessionRow>(`SELECT * FROM sessions ${clause} ORDER BY id`)
      .all(params)
      .map(toSession);
  }

  get(id: number): Session | undefined {
    const row = this.db.prepare<[number], SessionRow>('SELECT * FROM sessions WHERE id = ?').get(id);
    return row && toSession(row);
  }

  require(id: number): Session {
    const session = this.get(id);
    if (!session) throw new NotFoundError('session', id);
    return session;
  }

  /** Like require(), but also checks the session belongs to `projectId`. */
  requireInProject(id: number, projectId: number): Session {
    const session = this.require(id);
    if (session.projectId !== projectId) {
      throw new ValidationError(`session ${id} belongs to project ${session.projectId}, not ${projectId}`);
    }
    return session;
  }

  /** Newest first. */
  list(filter: SessionFilter = {}): Session[] {
    const { clause, params } = where({
      project_id: filter.projectId,
      status: filter.status,
      source: filter.source,
    });
    return this.db
      .prepare<[Record<string, unknown>], SessionRow>(`SELECT * FROM sessions ${clause} ORDER BY id DESC`)
      .all(params)
      .map(toSession);
  }

  /**
   * Moving to "ended" stamps endedAt; moving out of it clears endedAt. Moving to "paused" records
   * pauseReason (default "manual"); any other status clears it.
   */
  update(id: number, patch: SessionPatch): Session {
    const current = this.require(id);
    if (current.source === 'import' && patch.status !== undefined && patch.status !== 'ended') {
      throw new ValidationError(`session ${id} is an imported past conversation and stays ended`);
    }
    if (patch.worktrees) this.validateWorktrees(current.projectId, patch.worktrees);
    if (patch.rigor !== undefined && !RIGOR_LEVELS.includes(patch.rigor)) {
      throw new ValidationError(`unknown rigor "${String(patch.rigor)}"`);
    }
    // undefined leaves the column alone; re-pausing a paused session keeps its reason unless given.
    let pauseReason: PauseReason | null | undefined;
    if (patch.status !== undefined || patch.pauseReason !== undefined) {
      const status = patch.status ?? current.status;
      const keep = status === 'paused' ? (current.pauseReason ?? undefined) : undefined;
      pauseReason = pauseReasonFor(status, patch.pauseReason ?? keep);
    }
    let endedAt: string | null | undefined;
    if (patch.status === 'ended' && current.status !== 'ended') endedAt = isoNow(this.clock);
    if (patch.status !== undefined && patch.status !== 'ended') endedAt = null;
    updateById(this.db, 'sessions', 'session', id, {
      title: patch.title,
      status: patch.status,
      pause_reason: pauseReason,
      provider: patch.provider,
      model: patch.model,
      effort: patch.effort,
      tmux_target: patch.tmuxTarget,
      agent_session_id: patch.agentSessionId,
      branch: patch.branch,
      worktrees: toJson(patch.worktrees),
      rigor: patch.rigor,
      // A level chosen here is the human's: it pins the level against the Planner.
      rigor_source: patch.rigor === undefined ? undefined : 'human',
      rigor_reason: patch.rigor === undefined ? undefined : null,
      ended_at: endedAt,
    });
    return this.require(id);
  }

  /**
   * Records the planner's plan, stamped now; a later plan replaces it. Its level pick applies only
   * while the human has not chosen one: the human's choice is never overridden.
   */
  setPlan(
    id: number,
    plan: string,
    pick?: { rigor: Rigor; reason: string | null },
    modelPicks?: ModelPicks,
  ): Session {
    if (plan.trim() === '') throw new ValidationError('the plan must not be empty');
    if (pick && !RIGOR_LEVELS.includes(pick.rigor)) {
      throw new ValidationError(`unknown rigor "${String(pick.rigor)}"`);
    }
    for (const [agent, model] of Object.entries(modelPicks?.models ?? {})) checkAgentModel(agent, model);
    const current = this.require(id);
    const apply = pick && current.rigorSource !== 'human';
    // New picks replace the Planner's earlier ones (they are per task); the human's entries stay.
    let models: AgentModels | undefined;
    if (modelPicks) {
      models = Object.fromEntries(Object.entries(current.models).filter(([, m]) => m.by === 'human'));
      for (const [agent, model] of Object.entries(modelPicks.models))
        if (!models[agent]) models[agent] = { model, by: 'planner' };
    }
    if (models && Object.keys(models).length > MAX_AGENT_MODELS)
      throw new ValidationError(`a session holds models for ${MAX_AGENT_MODELS} agents at most`);
    const planned = models && Object.values(models).some((m) => m.by === 'planner');
    updateById(this.db, 'sessions', 'session', id, {
      plan,
      planned_at: isoNow(this.clock),
      rigor: apply ? pick.rigor : undefined,
      rigor_source: apply ? 'planner' : undefined,
      rigor_reason: apply ? pick.reason || null : undefined,
      ...(models
        ? {
            models: Object.keys(models).length > 0 ? toJson(models) : null,
            models_reason: planned ? modelPicks?.reason || null : null,
          }
        : {}),
    });
    return this.require(id);
  }

  /**
   * Sets one agent's model, or with `model` null clears it (back to the default). A human's choice
   * pins the agent against the Planner; clearing it frees the agent for the Planner again.
   */
  setAgentModel(id: number, agent: string, model: string | null): Session {
    if (model !== null) checkAgentModel(agent, model);
    else if (!isAgentId(agent)) throw new ValidationError(`unknown agent "${agent}"`);
    const models = { ...this.require(id).models };
    if (model === null) delete models[agent];
    else {
      if (!(agent in models) && Object.keys(models).length >= MAX_AGENT_MODELS)
        throw new ValidationError(`a session holds models for ${MAX_AGENT_MODELS} agents at most`);
      models[agent] = { model, by: 'human' };
    }
    const planned = Object.values(models).some((m) => m.by === 'planner');
    updateById(this.db, 'sessions', 'session', id, {
      models: Object.keys(models).length > 0 ? toJson(models) : null,
      ...(planned ? {} : { models_reason: null }),
    });
    return this.require(id);
  }

  end(id: number): Session {
    return this.update(id, { status: 'ended' });
  }

  private validateWorktrees(projectId: number, worktrees: Worktree[]): void {
    const project = this.projects.require(projectId);
    const known = new Set(project.repos.map((r) => r.name));
    const seen = new Set<string>();
    for (const wt of worktrees) {
      if (!known.has(wt.repo)) {
        throw new ValidationError(`worktree refers to unknown repo "${wt.repo}" in project ${project.name}`);
      }
      if (seen.has(wt.repo)) throw new ValidationError(`more than one worktree for repo "${wt.repo}"`);
      seen.add(wt.repo);
    }
  }
}
