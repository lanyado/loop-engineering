import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Session } from '@loop-engineering/core';
import type { ServerContext, ServerModule } from '../context.js';

/** A subagent OpenCode ran for a conversation in some folder: its child session. */
export interface OpencodeChild {
  id: string;
  title: string;
  model: string;
  /** Epoch ms of its last activity. */
  updatedAt: number;
}

/** Reads OpenCode's subagents: child sessions of the conversations started in `directory` since `since`. */
export type OpencodeChildSource = (directory: string, since: number) => OpencodeChild[];

export const DEFAULT_OPENCODE_DB = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');

/** OpenCode's own SQLite database, opened read-only for each read (it is OpenCode's, never written). */
export function opencodeDbSource(file = DEFAULT_OPENCODE_DB): OpencodeChildSource {
  return (directory, since) => {
    let db: Database.Database | null = null;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true });
      const rows = db
        .prepare<
          [string, number],
          { id: string; title: string | null; model: string | null; time_updated: number }
        >(
          `SELECT c.id, c.title, c.model, c.time_updated FROM session_v2 c
           JOIN session_v2 p ON p.id = c.parent_id
           WHERE p.directory = ? AND p.parent_id IS NULL AND p.time_created >= ?
           ORDER BY c.time_created`,
        )
        .all(directory, since);
      return rows.map((r) => ({
        id: r.id,
        title: r.title?.trim() || 'subagent',
        model: modelName(r.model),
        updatedAt: r.time_updated,
      }));
    } catch {
      return []; // no OpenCode database (yet), or a schema this version does not know
    } finally {
      db?.close();
    }
  };
}

function modelName(raw: string | null): string {
  try {
    const m = JSON.parse(raw ?? '') as { id?: unknown; providerID?: unknown };
    if (typeof m.id === 'string') return typeof m.providerID === 'string' ? `${m.providerID}/${m.id}` : m.id;
  } catch {
    // not JSON
  }
  return raw ?? 'unknown';
}

/** A subagent with no activity for this long has finished. */
const IDLE_MS = 2 * 60_000;

/** The folder an OpenCode session's agent runs in: its one worktree, the parent of several, or the project folder. */
function agentFolder(ctx: ServerContext, s: Session): string | null {
  if (s.worktrees.length === 1) return s.worktrees[0]!.path;
  if (s.worktrees.length > 1) return dirname(s.worktrees[0]!.path);
  return ctx.store.projects.get(s.projectId)?.folderPath ?? null;
}

export interface OpencodeSubagentsOptions {
  source?: OpencodeChildSource;
  /** Default 30 s. */
  intervalMs?: number;
}

/**
 * Records the subagents of running OpenCode sessions (OpenCode child sessions) in the subagents table,
 * so the dashboard shows them on the session's Builder node. Read-only towards OpenCode.
 */
export function opencodeSubagentsModule(
  options: OpencodeSubagentsOptions = {},
): ServerModule & { sync(): void } {
  const source = options.source ?? opencodeDbSource();
  let ctx: ServerContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const sync = () => {
    if (!ctx) return;
    const { store } = ctx;
    const now = ctx.clock.now().getTime();
    for (const s of store.sessions.list({ status: ['active', 'paused'] })) {
      if (s.provider !== 'opencode') continue;
      const folder = agentFolder(ctx, s);
      if (!folder) continue;
      for (const child of source(folder, Date.parse(s.createdAt) - 60_000)) {
        store.subagents.upsertExternal({
          sessionId: s.id,
          externalId: child.id,
          title: child.title.slice(0, 200),
          model: child.model,
          effort: s.effort ?? 'high',
          status: now - child.updatedAt < IDLE_MS && s.status === 'active' ? 'running' : 'done',
        });
      }
    }
  };

  return {
    name: 'opencode-subagents',
    sync,
    start(c) {
      ctx = c;
      timer = setInterval(() => {
        try {
          sync();
        } catch (error) {
          console.log(`[opencode-subagents] ${String(error)}`);
        }
      }, options.intervalMs ?? 30_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      ctx = null;
    },
  };
}
