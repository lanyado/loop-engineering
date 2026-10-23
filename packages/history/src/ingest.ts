import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  envFileValues,
  errorMessage,
  maskEdgeFragments,
  redactSecrets,
  type HistoryEntry,
  type Project,
  type Session,
  type Store,
} from '@loop-engineering/core';
import {
  agentCwd,
  compactTranscript,
  findTranscript,
  nodeTranscriptFs,
  type TranscriptFs,
} from './transcript.js';

export interface IngestOptions {
  /** Claude's conversations folder. Default `$CLAUDE_CONFIG_DIR/projects` or ~/.claude/projects. */
  projectsDir?: string;
  fs?: TranscriptFs;
  /** Cap on the stored text. Default 60 000 characters. */
  maxChars?: number;
  /** Sessions ingested per sweep. Default 20. */
  batch?: number;
  /** How long a session with no saved transcript is skipped before looking again. Default 10 minutes. */
  missingRetryMs?: number;
  env?: Record<string, string | undefined>;
  /** Extra values masked in stored transcripts (the server's own secrets). */
  secrets?: readonly string[];
  log?: (message: string) => void;
}

export function defaultProjectsDir(env: Record<string, string | undefined> = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
}

/**
 * Stores a compact transcript (user and assistant text) of each paused or ended Claude session as a
 * `transcript` history entry, one per session: a newer transcript replaces the older entry. sweep()
 * finds sessions whose transcript file changed since it was last stored; call it on a timer, and
 * ingestSession() right after pausing or ending one. OpenCode sessions have no Claude transcript;
 * imported sessions (importProjectSessions) are left alone.
 */
export class TranscriptIngester {
  private readonly projectsDir: string;
  private readonly fs: TranscriptFs;
  private readonly log: (message: string) => void;
  private readonly missing = new Map<number, number>();
  /** Last transcript mtime seen per session, so an unchanged file is not read again. */
  private readonly seen = new Map<number, number>();

  constructor(
    private readonly store: Store,
    private readonly options: IngestOptions = {},
  ) {
    this.projectsDir = options.projectsDir ?? defaultProjectsDir(options.env);
    this.fs = options.fs ?? nodeTranscriptFs;
    this.log = options.log ?? ((m) => console.warn(`[history] ${m}`));
  }

  /** Ingests the session's transcript if it changed since the stored one. Returns the new entry, if any. */
  async ingestSession(sessionId: number): Promise<HistoryEntry | null> {
    const s = this.store.sessions.get(sessionId);
    if (!s?.agentSessionId) return null;
    const path = await findTranscript(this.fs, this.projectsDir, agentCwd(s.worktrees), s.agentSessionId);
    if (!path) {
      this.missing.set(s.id, this.store.clock.now().getTime());
      return null;
    }
    this.missing.delete(s.id);
    const mtime = await this.fs.mtimeMs(path);
    if (mtime !== null && this.seen.get(s.id) === mtime) return null;
    const stored = this.latest(s.id);
    if (stored && mtime !== null && mtime <= Date.parse(stored.createdAt)) {
      this.seen.set(s.id, mtime);
      return null;
    }
    // Tokens pasted into a request or echoed by the agent must not reach search results. Each
    // message is redacted whole before the transcript is cut to size.
    const project = this.store.projects.require(s.projectId);
    const secrets = [...(await this.envValues(project)), ...(this.options.secrets ?? [])];
    const raw = compactTranscript(await this.fs.readFile(path), {
      maxChars: this.options.maxChars,
      redact: (t) => maskEdgeFragments(redactSecrets(t, secrets)),
    });
    if (mtime !== null) this.seen.set(s.id, mtime);
    if (!raw) return null;
    const body = redactSecrets(raw, secrets);
    const text = `Session ${s.id} "${s.title}" (branch ${s.branch}, ${s.status})\n\n${body}`;
    return this.store.transaction(() => {
      for (const old of this.store.history.list({ sessionId: s.id, kind: 'transcript', limit: 1000 }))
        this.store.history.delete(old.id);
      return this.store.history.add({ projectId: s.projectId, sessionId: s.id, kind: 'transcript', text });
    });
  }

  /** Ingests paused and ended sessions whose transcript is new or changed. Returns how many were stored. */
  async sweep(): Promise<number> {
    const now = this.store.clock.now().getTime();
    const retry = this.options.missingRetryMs ?? 10 * 60_000;
    // Incremental: an ended session whose transcript was stored after it ended is done for good.
    const done = (s: Session) => {
      if (s.status !== 'ended' || !s.endedAt) return false;
      const stored = this.latest(s.id);
      return stored !== undefined && stored.createdAt >= s.endedAt;
    };
    const due = this.store.sessions
      // Imported conversations get their transcript from the importer, once.
      .list({ status: ['paused', 'ended'], source: 'runner' })
      .filter((s: Session) => s.agentSessionId !== null)
      .filter((s) => now - (this.missing.get(s.id) ?? -Infinity) >= retry)
      .filter((s) => !done(s));
    let stored = 0;
    let checked = 0;
    for (const s of due) {
      if (checked >= (this.options.batch ?? 20)) break;
      try {
        const entry = await this.ingestSession(s.id);
        if (entry) {
          stored++;
          checked++;
        }
      } catch (err) {
        checked++;
        this.log(`could not ingest the transcript of session ${s.id}: ${errorMessage(err)}`);
      }
    }
    return stored;
  }

  private async envValues(project: Project): Promise<string[]> {
    const values: string[] = [];
    for (const file of project.envFiles) {
      try {
        values.push(...envFileValues(await this.fs.readFile(file.source)));
      } catch {
        this.log(`could not read an env file of project ${project.name} (${file.repo}/${file.target})`);
      }
    }
    return values;
  }

  private latest(sessionId: number): HistoryEntry | undefined {
    return this.store.history.list({ sessionId, kind: 'transcript', limit: 1 })[0];
  }
}
