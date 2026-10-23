import { isoNow, type Clock } from '../clock.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { parseJson, toJson, updateById, where, type Db } from '../sql.js';
import type { PrOutcome, PrStage, PullRequest } from '../types.js';
import type { ProjectRepo } from './projects.js';
import type { RequestRepo } from './requests.js';
import type { SessionRepo } from './sessions.js';

export interface NewPullRequest {
  projectId: number;
  repo: string;
  number: number;
  url: string;
  sessionId?: number | null;
  requestId?: number | null;
  stage?: PrStage;
  round?: number;
  fixesPrId?: number | null;
}

export type PullRequestPatch = Partial<
  Pick<
    PullRequest,
    | 'sessionId'
    | 'requestId'
    | 'url'
    | 'stage'
    | 'round'
    | 'outcome'
    | 'mergeCommitSha'
    | 'revertedByPrId'
    | 'fixesPrId'
    | 'loopState'
  >
>;

export interface PullRequestFilter {
  projectId?: number;
  sessionId?: number;
  requestId?: number;
  stage?: PrStage | PrStage[];
  /** true: still in the loop (no outcome); false: finished. */
  open?: boolean;
}

interface PullRequestRow {
  id: number;
  project_id: number;
  session_id: number | null;
  request_id: number | null;
  repo: string;
  number: number;
  url: string;
  stage: PrStage;
  round: number;
  outcome: PrOutcome | null;
  merge_commit_sha: string | null;
  reverted_by_pr_id: number | null;
  fixes_pr_id: number | null;
  loop_state: string;
  created_at: string;
  updated_at: string;
}

const toPullRequest = (r: PullRequestRow): PullRequest => ({
  id: r.id,
  projectId: r.project_id,
  sessionId: r.session_id,
  requestId: r.request_id,
  repo: r.repo,
  number: r.number,
  url: r.url,
  stage: r.stage,
  round: r.round,
  outcome: r.outcome,
  mergeCommitSha: r.merge_commit_sha,
  revertedByPrId: r.reverted_by_pr_id,
  fixesPrId: r.fixes_pr_id,
  loopState: parseJson<Record<string, unknown>>(r.loop_state),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class PullRequestRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly projects: ProjectRepo,
    private readonly sessions: SessionRepo,
    private readonly requests: RequestRepo,
  ) {}

  create(input: NewPullRequest): PullRequest {
    const project = this.projects.require(input.projectId);
    if (!project.repos.some((r) => r.name === input.repo)) {
      throw new ValidationError(`unknown repo "${input.repo}" in project ${project.name}`);
    }
    this.validateLinks(input.projectId, input);
    const now = isoNow(this.clock);
    const info = this.db
      .prepare(
        `INSERT INTO pull_requests
           (project_id, session_id, request_id, repo, number, url, stage, round, fixes_pr_id, created_at, updated_at)
         VALUES
           (@projectId, @sessionId, @requestId, @repo, @number, @url, @stage, @round, @fixesPrId, @now, @now)`,
      )
      .run({
        projectId: input.projectId,
        sessionId: input.sessionId ?? null,
        requestId: input.requestId ?? null,
        repo: input.repo,
        number: input.number,
        url: input.url,
        stage: input.stage ?? 'tests',
        round: input.round ?? 0,
        fixesPrId: input.fixesPrId ?? null,
        now,
      });
    return this.require(Number(info.lastInsertRowid));
  }

  get(id: number): PullRequest | undefined {
    const row = this.db.prepare<[number], PullRequestRow>('SELECT * FROM pull_requests WHERE id = ?').get(id);
    return row && toPullRequest(row);
  }

  require(id: number): PullRequest {
    const pr = this.get(id);
    if (!pr) throw new NotFoundError('pull request', id);
    return pr;
  }

  getByNumber(projectId: number, repo: string, number: number): PullRequest | undefined {
    const row = this.db
      .prepare<[number, string, number], PullRequestRow>(
        'SELECT * FROM pull_requests WHERE project_id = ? AND repo = ? AND number = ?',
      )
      .get(projectId, repo, number);
    return row && toPullRequest(row);
  }

  /** Newest first. */
  list(filter: PullRequestFilter = {}): PullRequest[] {
    const conditions =
      filter.open === undefined ? [] : [filter.open ? 'outcome IS NULL' : 'outcome IS NOT NULL'];
    const { clause, params } = where(
      {
        project_id: filter.projectId,
        session_id: filter.sessionId,
        request_id: filter.requestId,
        stage: filter.stage,
      },
      conditions,
    );
    return this.db
      .prepare<[Record<string, unknown>], PullRequestRow>(
        `SELECT * FROM pull_requests ${clause} ORDER BY id DESC`,
      )
      .all(params)
      .map(toPullRequest);
  }

  update(id: number, patch: PullRequestPatch): PullRequest {
    const current = this.require(id);
    this.validateLinks(current.projectId, patch, id);
    updateById(this.db, 'pull_requests', 'pull request', id, {
      session_id: patch.sessionId,
      request_id: patch.requestId,
      url: patch.url,
      stage: patch.stage,
      round: patch.round,
      outcome: patch.outcome,
      merge_commit_sha: patch.mergeCommitSha,
      reverted_by_pr_id: patch.revertedByPrId,
      fixes_pr_id: patch.fixesPrId,
      loop_state: toJson(patch.loopState),
      updated_at: isoNow(this.clock),
    });
    return this.require(id);
  }

  /** Every linked row must exist (NotFoundError) and belong to the same project (ValidationError). */
  private validateLinks(
    projectId: number,
    links: Pick<PullRequestPatch, 'sessionId' | 'requestId' | 'revertedByPrId' | 'fixesPrId'>,
    selfId?: number,
  ): void {
    if (links.sessionId != null) this.sessions.requireInProject(links.sessionId, projectId);
    if (links.requestId != null && this.requests.require(links.requestId).projectId !== projectId) {
      throw new ValidationError(`request ${links.requestId} belongs to another project`);
    }
    for (const prId of [links.revertedByPrId, links.fixesPrId]) {
      if (prId == null) continue;
      if (prId === selfId) throw new ValidationError('a pull request cannot link to itself');
      if (this.require(prId).projectId !== projectId) {
        throw new ValidationError(`pull request ${prId} belongs to another project`);
      }
    }
  }
}
