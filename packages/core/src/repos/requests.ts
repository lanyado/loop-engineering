import { isoNow, type Clock } from '../clock.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { updateById, where, type Db } from '../sql.js';
import { REQUEST_SOURCES, type Request, type RequestSource, type RetiredChannel } from '../types.js';
import type { ProjectRepo } from './projects.js';
import type { SessionRepo } from './sessions.js';

export interface NewRequest {
  /** Omit (or null) for a request the router has not routed yet, e.g. one from a channel that names no project. */
  projectId?: number | null;
  text: string;
  /** A retired channel only for a part of a request that came through it (the part keeps its source). */
  source: RequestSource | RetiredChannel;
  /** Needs a projectId. */
  sessionId?: number | null;
  /** The session the human addressed it to; needs a projectId, and the session must be in it. */
  targetSessionId?: number | null;
  /** A part of this request (needs the same projectId). */
  parentRequestId?: number | null;
}

export interface RequestFilter {
  /** null: requests not routed to a project yet. */
  projectId?: number | null;
  sessionId?: number;
}

interface RequestRow {
  id: number;
  project_id: number | null;
  session_id: number | null;
  target_session_id: number | null;
  parent_request_id: number | null;
  text: string;
  source: RequestSource | RetiredChannel;
  created_at: string;
}

const toRequest = (r: RequestRow): Request => ({
  id: r.id,
  projectId: r.project_id,
  sessionId: r.session_id,
  targetSessionId: r.target_session_id,
  parentRequestId: r.parent_request_id,
  text: r.text,
  source: r.source,
  createdAt: r.created_at,
});

/** The human's original task text, so the router can record its session and the reviewer can check PRs against it. */
export class RequestRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly projects: ProjectRepo,
    private readonly sessions: SessionRepo,
  ) {}

  create(input: NewRequest): Request {
    if (input.text.trim() === '') throw new ValidationError('request text must not be empty');
    const projectId = input.projectId ?? null;
    if (projectId !== null) this.projects.require(projectId);
    if (input.sessionId != null) {
      if (projectId === null) throw new ValidationError('a request with a session needs its projectId');
      this.sessions.requireInProject(input.sessionId, projectId);
    }
    if (input.targetSessionId != null) {
      if (projectId === null) throw new ValidationError('a request for a session needs its projectId');
      this.sessions.requireInProject(input.targetSessionId, projectId);
    }
    const parent = input.parentRequestId != null ? this.require(input.parentRequestId) : undefined;
    if (parent && (projectId === null || parent.projectId !== projectId))
      throw new ValidationError('a part of a request is in its project');
    // The database also accepts a retired channel, for the rows it wrote; new requests never get it.
    if (!(REQUEST_SOURCES as readonly string[]).includes(input.source) && parent?.source !== input.source)
      throw new ValidationError(
        `requests come from ${REQUEST_SOURCES.join(' or ')}, not "${String(input.source)}"`,
      );
    const info = this.db
      .prepare(
        `INSERT INTO requests (project_id, session_id, target_session_id, parent_request_id, text, source, created_at)
         VALUES (@projectId, @sessionId, @targetSessionId, @parentRequestId, @text, @source, @createdAt)`,
      )
      .run({
        parentRequestId: input.parentRequestId ?? null,
        projectId,
        sessionId: input.sessionId ?? null,
        targetSessionId: input.targetSessionId ?? null,
        text: input.text,
        source: input.source,
        createdAt: isoNow(this.clock),
      });
    return this.require(Number(info.lastInsertRowid));
  }

  get(id: number): Request | undefined {
    const row = this.db.prepare<[number], RequestRow>('SELECT * FROM requests WHERE id = ?').get(id);
    return row && toRequest(row);
  }

  require(id: number): Request {
    const request = this.get(id);
    if (!request) throw new NotFoundError('request', id);
    return request;
  }

  /** Oldest first, so a session's requests read in the order they arrived. */
  list(filter: RequestFilter = {}): Request[] {
    const { clause, params } = where({ project_id: filter.projectId, session_id: filter.sessionId });
    return this.db
      .prepare<[Record<string, unknown>], RequestRow>(`SELECT * FROM requests ${clause} ORDER BY id`)
      .all(params)
      .map(toRequest);
  }

  /**
   * When each session got its newest task from the human: session id → the latest createdAt of its
   * requests. The loop's own "[loop]" fix requests are not tasks to plan.
   */
  latestBySession(): Map<number, string> {
    const rows = this.db
      .prepare<[], { session_id: number; latest: string }>(
        `SELECT session_id, MAX(created_at) AS latest FROM requests
         WHERE session_id IS NOT NULL AND text NOT LIKE '[loop]%' GROUP BY session_id`,
      )
      .all();
    return new Map(rows.map((r) => [r.session_id, r.latest]));
  }

  /** The parts the router split a request into, oldest first. */
  parts(id: number): Request[] {
    return this.db
      .prepare<[number], RequestRow>('SELECT * FROM requests WHERE parent_request_id = ? ORDER BY id')
      .all(id)
      .map(toRequest);
  }

  /** Records the project the router picked for an unrouted request. */
  assignProject(id: number, projectId: number): Request {
    const request = this.require(id);
    this.projects.require(projectId);
    if (request.projectId !== null && request.projectId !== projectId) {
      throw new ValidationError(`request ${id} is already routed to project ${request.projectId}`);
    }
    updateById(this.db, 'requests', 'request', id, { project_id: projectId });
    return this.require(id);
  }

  /** Records which session the router delivered the request to (and its project, if unrouted). */
  assignSession(id: number, sessionId: number): Request {
    const request = this.require(id);
    const session =
      request.projectId === null
        ? this.sessions.require(sessionId)
        : this.sessions.requireInProject(sessionId, request.projectId);
    updateById(this.db, 'requests', 'request', id, { project_id: session.projectId, session_id: sessionId });
    return this.require(id);
  }

  /** Updates the request text (used by the Plan stage to add clarifications). */
  updateText(id: number, text: string): Request {
    if (text.trim() === '') throw new ValidationError('request text must not be empty');
    updateById(this.db, 'requests', 'request', id, { text });
    return this.require(id);
  }
}
