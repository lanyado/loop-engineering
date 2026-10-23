import { isoNow, type Clock } from '../clock.js';
import { NotFoundError } from '../errors.js';
import { updateById, where, type Db } from '../sql.js';
import type { Effort, Subagent, SubagentStatus } from '../types.js';
import type { SessionRepo } from './sessions.js';

export interface NewSubagent {
  sessionId: number;
  title: string;
  model: string;
  effort: Effort;
  status?: SubagentStatus;
  externalId?: string | null;
}

export type SubagentPatch = Partial<Pick<Subagent, 'title' | 'model' | 'effort' | 'status'>>;

export interface SubagentFilter {
  /** One session, or several in one query (the dashboard tree). */
  sessionId?: number | number[];
  status?: SubagentStatus | SubagentStatus[];
}

interface SubagentRow {
  id: number;
  session_id: number;
  external_id: string | null;
  title: string;
  model: string;
  effort: Effort;
  status: SubagentStatus;
  created_at: string;
}

const toSubagent = (r: SubagentRow): Subagent => ({
  id: r.id,
  sessionId: r.session_id,
  externalId: r.external_id,
  title: r.title,
  model: r.model,
  effort: r.effort,
  status: r.status,
  createdAt: r.created_at,
});

export class SubagentRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly sessions: SessionRepo,
  ) {}

  create(input: NewSubagent): Subagent {
    this.sessions.require(input.sessionId);
    const info = this.db
      .prepare(
        `INSERT INTO subagents (session_id, external_id, title, model, effort, status, created_at)
         VALUES (@sessionId, @externalId, @title, @model, @effort, @status, @createdAt)`,
      )
      .run({
        sessionId: input.sessionId,
        externalId: input.externalId ?? null,
        title: input.title,
        model: input.model,
        effort: input.effort,
        status: input.status ?? 'running',
        createdAt: isoNow(this.clock),
      });
    return this.require(Number(info.lastInsertRowid));
  }

  /** Records a subagent found in an agent CLI, or updates the one recorded with that external id. */
  upsertExternal(input: NewSubagent & { externalId: string }): Subagent {
    const row = this.db
      .prepare<[number, string], { id: number }>(
        'SELECT id FROM subagents WHERE session_id = ? AND external_id = ?',
      )
      .get(input.sessionId, input.externalId);
    if (!row) return this.create(input);
    return this.update(row.id, { title: input.title, model: input.model, status: input.status ?? 'running' });
  }

  get(id: number): Subagent | undefined {
    const row = this.db.prepare<[number], SubagentRow>('SELECT * FROM subagents WHERE id = ?').get(id);
    return row && toSubagent(row);
  }

  require(id: number): Subagent {
    const subagent = this.get(id);
    if (!subagent) throw new NotFoundError('subagent', id);
    return subagent;
  }

  /** Oldest first. */
  list(filter: SubagentFilter = {}): Subagent[] {
    const { clause, params } = where({ session_id: filter.sessionId, status: filter.status });
    return this.db
      .prepare<[Record<string, unknown>], SubagentRow>(`SELECT * FROM subagents ${clause} ORDER BY id`)
      .all(params)
      .map(toSubagent);
  }

  update(id: number, patch: SubagentPatch): Subagent {
    updateById(this.db, 'subagents', 'subagent', id, {
      title: patch.title,
      model: patch.model,
      effort: patch.effort,
      status: patch.status,
    });
    return this.require(id);
  }
}
