import { isoNow, type Clock } from '../clock.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { deleteById, where, type Db } from '../sql.js';
import type { HistoryEntry, HistoryKind, HistorySearchHit } from '../types.js';
import type { ProjectRepo } from './projects.js';
import type { SessionRepo } from './sessions.js';

export interface NewHistoryEntry {
  projectId: number;
  sessionId?: number | null;
  kind: HistoryKind;
  text: string;
}

export interface HistoryFilter {
  projectId?: number;
  sessionId?: number;
  kind?: HistoryKind;
  limit?: number;
}

export interface HistorySearchOptions extends HistoryFilter {
  /**
   * Pass the query to FTS5 as-is (operators, prefixes, phrases); invalid syntax throws.
   * Default (false): the query is split into plain words and an entry must contain every one of them
   * (AND). Operators are not special then: `foo OR bar` needs the word "or" too.
   */
  raw?: boolean;
}

interface HistoryRow {
  id: number;
  project_id: number;
  session_id: number | null;
  kind: HistoryKind;
  text: string;
  created_at: string;
}

const toEntry = (r: HistoryRow): HistoryEntry => ({
  id: r.id,
  projectId: r.project_id,
  sessionId: r.session_id,
  kind: r.kind,
  text: r.text,
  createdAt: r.created_at,
});

/**
 * Turns free text into an FTS5 query that matches entries containing every word. Each word is
 * quoted so user input such as `don't`, `a-b` or `NOT` cannot be read as FTS5 syntax.
 */
export function toFtsQuery(text: string): string {
  const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.map((w) => `"${w}"`).join(' ');
}

const DEFAULT_LIMIT = 50;

export class HistoryRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly projects: ProjectRepo,
    private readonly sessions: SessionRepo,
  ) {}

  add(input: NewHistoryEntry): HistoryEntry {
    if (input.text.trim() === '') throw new ValidationError('history text must not be empty');
    this.projects.require(input.projectId);
    if (input.sessionId != null) this.sessions.requireInProject(input.sessionId, input.projectId);
    const info = this.db
      .prepare(
        `INSERT INTO history_entries (project_id, session_id, kind, text, created_at)
         VALUES (@projectId, @sessionId, @kind, @text, @createdAt)`,
      )
      .run({
        projectId: input.projectId,
        sessionId: input.sessionId ?? null,
        kind: input.kind,
        text: input.text,
        createdAt: isoNow(this.clock),
      });
    return this.require(Number(info.lastInsertRowid));
  }

  get(id: number): HistoryEntry | undefined {
    const row = this.db.prepare<[number], HistoryRow>('SELECT * FROM history_entries WHERE id = ?').get(id);
    return row && toEntry(row);
  }

  require(id: number): HistoryEntry {
    const entry = this.get(id);
    if (!entry) throw new NotFoundError('history entry', id);
    return entry;
  }

  /** Newest first. */
  list(filter: HistoryFilter = {}): HistoryEntry[] {
    const { clause, params } = where({
      project_id: filter.projectId,
      session_id: filter.sessionId,
      kind: filter.kind,
    });
    return this.db
      .prepare<[Record<string, unknown>], HistoryRow>(
        `SELECT * FROM history_entries ${clause} ORDER BY id DESC LIMIT @limit`,
      )
      .all({ ...params, limit: filter.limit ?? DEFAULT_LIMIT })
      .map(toEntry);
  }

  /** Full-text search, best match first. By default all words must match (see HistorySearchOptions.raw). */
  search(query: string, options: HistorySearchOptions = {}): HistorySearchHit[] {
    const match = options.raw ? query : toFtsQuery(query);
    if (match.trim() === '') return [];
    const { clause, params } = where(
      { 'h.project_id': options.projectId, 'h.session_id': options.sessionId, 'h.kind': options.kind },
      ['history_fts MATCH @match'],
    );
    return this.db
      .prepare<[Record<string, unknown>], HistoryRow & { snippet: string; score: number }>(
        `SELECT h.*, snippet(history_fts, 0, '[', ']', '…', 12) AS snippet, bm25(history_fts) AS score
         FROM history_fts JOIN history_entries h ON h.id = history_fts.rowid
         ${clause}
         ORDER BY score, h.id DESC
         LIMIT @limit`,
      )
      .all({ ...params, match, limit: options.limit ?? DEFAULT_LIMIT })
      .map((r) => ({ ...toEntry(r), snippet: r.snippet, rank: r.score }));
  }

  delete(id: number): boolean {
    return deleteById(this.db, 'history_entries', id);
  }
}
