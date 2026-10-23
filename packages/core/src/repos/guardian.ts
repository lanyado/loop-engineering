import { isoNow, type Clock } from '../clock.js';
import { NotFoundError } from '../errors.js';
import { fromBool, parseJson, toBool, toJson, updateById, where, type Db } from '../sql.js';
import type { GuardianAreaResult, GuardianRun, GuardianStatus, GuardianTrigger } from '../types.js';
import type { ProjectRepo } from './projects.js';

export interface NewGuardianRun {
  projectId: number;
  repo: string;
  trigger: GuardianTrigger;
  prId?: number | null;
}

export type GuardianPatch = Partial<
  Pick<GuardianRun, 'status' | 'critical' | 'summary' | 'areas' | 'diagnosis' | 'evidenceDir' | 'requestId'>
> & { finished?: boolean };

export interface GuardianFilter {
  projectId?: number;
  repo?: string;
  trigger?: GuardianTrigger;
  prId?: number;
  status?: GuardianStatus | GuardianStatus[];
}

interface GuardianRow {
  id: number;
  project_id: number;
  repo: string;
  trigger: GuardianTrigger;
  pr_id: number | null;
  status: GuardianStatus;
  critical: number;
  summary: string;
  areas: string;
  diagnosis: string;
  evidence_dir: string | null;
  request_id: number | null;
  created_at: string;
  finished_at: string | null;
}

const toRun = (r: GuardianRow): GuardianRun => ({
  id: r.id,
  projectId: r.project_id,
  repo: r.repo,
  trigger: r.trigger,
  prId: r.pr_id,
  status: r.status,
  critical: toBool(r.critical),
  summary: r.summary,
  areas: parseJson<GuardianAreaResult[]>(r.areas),
  diagnosis: r.diagnosis,
  evidenceDir: r.evidence_dir,
  requestId: r.request_id,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

/** Production Guardian runs, newest last by id. */
export class GuardianRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly projects: ProjectRepo,
  ) {}

  create(input: NewGuardianRun): GuardianRun {
    this.projects.require(input.projectId);
    const info = this.db
      .prepare(
        `INSERT INTO guardian_runs (project_id, repo, trigger, pr_id, created_at)
         VALUES (@projectId, @repo, @trigger, @prId, @now)`,
      )
      .run({
        projectId: input.projectId,
        repo: input.repo,
        trigger: input.trigger,
        prId: input.prId ?? null,
        now: isoNow(this.clock),
      });
    return this.require(Number(info.lastInsertRowid));
  }

  get(id: number): GuardianRun | undefined {
    const row = this.db.prepare<[number], GuardianRow>('SELECT * FROM guardian_runs WHERE id = ?').get(id);
    return row && toRun(row);
  }

  require(id: number): GuardianRun {
    const run = this.get(id);
    if (!run) throw new NotFoundError('guardian run', id);
    return run;
  }

  /** Oldest first; `limit` keeps the newest ones. */
  list(filter: GuardianFilter = {}, limit?: number): GuardianRun[] {
    const { clause, params } = where({
      project_id: filter.projectId,
      repo: filter.repo,
      trigger: filter.trigger,
      pr_id: filter.prId,
      status: filter.status,
    });
    const rows = this.db
      .prepare<Record<string, unknown>, GuardianRow>(
        `SELECT * FROM (SELECT * FROM guardian_runs ${clause} ORDER BY id DESC LIMIT @limit) ORDER BY id`,
      )
      .all({ ...params, limit: limit ?? -1 });
    return rows.map(toRun);
  }

  update(id: number, patch: GuardianPatch): GuardianRun {
    updateById(this.db, 'guardian_runs', 'guardian run', id, {
      status: patch.status,
      critical: fromBool(patch.critical),
      summary: patch.summary,
      areas: toJson(patch.areas),
      diagnosis: patch.diagnosis,
      evidence_dir: patch.evidenceDir,
      request_id: patch.requestId,
      finished_at: patch.finished ? isoNow(this.clock) : undefined,
    });
    return this.require(id);
  }
}
