import { isoNow, type Clock } from '../clock.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { parseJson, toJson, updateById, where, type Db } from '../sql.js';
import {
  RIGOR_LEVELS,
  type Effort,
  type PauseReason,
  type Provider,
  type Rigor,
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
      ended_at: endedAt,
    });
    return this.require(id);
  }

  /** Records the planner's plan, stamped now; a later plan replaces it. */
  setPlan(id: number, plan: string): Session {
    if (plan.trim() === '') throw new ValidationError('the plan must not be empty');
    updateById(this.db, 'sessions', 'session', id, { plan, planned_at: isoNow(this.clock) });
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
