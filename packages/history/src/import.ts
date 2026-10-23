import { constants, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  envFileValues,
  maskEdgeFragments,
  redactSecrets,
  ValidationError,
  type Project,
  type Session,
  type Store,
} from '@loop-engineering/core';
import { encodeProjectDir, parseTranscriptLine, redactMessage, TranscriptCompactor } from './transcript.js';

/*
 * Imports past Claude Code conversations of a project as ended sessions, each with its compact,
 * redacted transcript in history. Strictly read-only on Claude's folder: files are opened with
 * O_RDONLY | O_NOFOLLOW and streamed line by line, symlinks are never followed, nothing there is
 * written, moved or deleted. Nothing read from a transcript is logged except redacted titles.
 */

export interface ImportOptions {
  /** Claude's conversations folder (`<claude dir>/projects`). */
  projectsDir: string;
  /** Extra folders of the project's conversations (e.g. worktrees): a folder name in projectsDir, or the absolute path Claude ran in. */
  alsoDirs?: readonly string[];
  /** Read and count only; store nothing. */
  dryRun?: boolean;
  /** Cap on each stored transcript. Default 60 000 characters. */
  maxChars?: number;
  /** Extra values masked in titles and transcripts (the server's own secrets). */
  secrets?: readonly string[];
  /**
   * A file changed this recently is skipped as still being written (a conversation in progress); a
   * later run imports it. Default 5 minutes; 0 imports everything.
   */
  activeWindowMs?: number;
}

export type ImportOutcome = 'imported' | 'would import';

export interface ImportedItem {
  outcome: ImportOutcome;
  /** Redacted, one line, at most TITLE_MAX characters. */
  title: string;
  agentSessionId: string;
  createdAt: string;
  endedAt: string;
  sessionId: number | null;
}

export interface ImportSummary {
  project: string;
  /** Folder names under projectsDir that were read, and whether each exists. */
  dirs: { name: string; found: boolean }[];
  /** Folders that look like this project's (same prefix) but were not read: candidates for alsoDirs. */
  notIncluded: string[];
  files: number;
  imported: ImportedItem[];
  skipped: {
    /** This project already has the conversation (imported before, or run by the session runner). */
    alreadyImported: number;
    /** No user or assistant text. */
    empty: number;
    /** Not a transcript: no line parses. */
    corrupt: number;
    /** Changed within activeWindowMs. */
    active: number;
    /** A symlink or not a regular file. */
    notPlainFile: number;
    /** Could not be opened or read (permissions). */
    unreadable: number;
  };
  /** Damaged lines left out of transcripts that were otherwise imported. */
  corruptLines: number;
}

export const TITLE_MAX = 80;
const CONVERSATION_FILE = /^([A-Za-z0-9][A-Za-z0-9-]*)\.jsonl$/;
const FOLDER_NAME = /^[A-Za-z0-9-]+$/;
/** User messages the harness writes on the human's behalf: never a title. */
const NOT_A_TITLE = [/^\[Request interrupted/i, /^Caveat:/i];
const MAX_ENV_FILE_BYTES = 1024 * 1024;

/** Folder names (under Claude's projects folder) where this project's conversations are saved. */
export async function projectDirNames(project: Project, alsoDirs: readonly string[] = []): Promise<string[]> {
  const roots = project.kind === 'folder' ? [project.folderPath ?? ''] : project.repos.map((r) => r.path);
  const names: string[] = [];
  const add = (name: string) => {
    if (!names.includes(name)) names.push(name);
  };
  for (const root of roots.filter(Boolean)) {
    // Claude names the folder after the cwd it ran in, which is the real path (symlinks resolved).
    add(encodeProjectDir(await realpathOr(root)));
    add(encodeProjectDir(root));
  }
  for (const extra of alsoDirs) {
    if (extra.startsWith('/')) {
      add(encodeProjectDir(await realpathOr(extra)));
      add(encodeProjectDir(extra));
    } else if (FOLDER_NAME.test(extra)) {
      add(extra);
    } else {
      throw new ValidationError(
        `--also-dir "${extra}" must be a folder name in Claude's projects folder (letters, digits and "-") or an absolute path`,
      );
    }
  }
  return names;
}

async function realpathOr(path: string): Promise<string> {
  try {
    return await fsp.realpath(path);
  } catch {
    return path;
  }
}

/** Collapses a first message into a short, single-line, redacted title. */
export function makeTitle(text: string, secrets: readonly string[]): string {
  // Redact before cutting, so a cut never leaves part of a secret behind. Control and format
  // characters go, so a title cannot move the cursor or recolor the terminal it is printed to.
  const line = redactSecrets(text, secrets)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (line.length <= TITLE_MAX) return line;
  // An unknown token cut in two could still be half a credential.
  return `${maskEdgeFragments(line.slice(0, TITLE_MAX - 1).trimEnd(), 'end')}…`;
}

interface Scan {
  lines: number;
  valid: number;
  corruptLines: number;
  firstAt: number | null;
  lastAt: number | null;
  model: string | null;
  title: string | null;
  transcript: string;
}

/** Streams one transcript. Never holds more than one line plus the capped transcript in memory. */
async function scanFile(
  path: string,
  maxChars: number | undefined,
  redact: (text: string) => string,
): Promise<Scan | 'not-plain'> {
  // O_NOFOLLOW: a symlink swapped in after the listing is refused, not followed.
  const handle = await fsp.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) return 'not-plain';
    const scan: Scan = {
      lines: 0,
      valid: 0,
      corruptLines: 0,
      firstAt: null,
      lastAt: null,
      model: null,
      title: null,
      transcript: '',
    };
    const compactor = new TranscriptCompactor(maxChars === undefined ? {} : { maxChars });
    const lines = createInterface({
      input: handle.createReadStream({ encoding: 'utf8', autoClose: false }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      scan.lines++;
      const parsed = parseTranscriptLine(line);
      if (parsed.kind === 'corrupt') {
        scan.corruptLines++;
        continue;
      }
      scan.valid++;
      if (parsed.kind !== 'message') continue;
      if (parsed.timestamp) {
        const at = Date.parse(parsed.timestamp);
        if (scan.firstAt === null || at < scan.firstAt) scan.firstAt = at;
        if (scan.lastAt === null || at > scan.lastAt) scan.lastAt = at;
      }
      if (parsed.model && !parsed.model.startsWith('<')) scan.model = parsed.model; // not "<synthetic>"
      // Each message is redacted whole, before anything (title, compaction) cuts it.
      const text = parsed.text ? redactMessage(parsed.text, redact) : '';
      if (scan.title === null && parsed.role === 'user' && text && !NOT_A_TITLE.some((re) => re.test(text))) {
        scan.title = text.slice(0, 4000);
      }
      compactor.add(parsed.role, text);
    }
    scan.transcript = compactor.result();
    return scan;
  } finally {
    await handle.close();
  }
}

/** Secret values of the project: its env files, and dotenv files at the top of its folders. */
async function projectSecrets(project: Project): Promise<string[]> {
  const files = project.envFiles.map((f) => f.source);
  const roots = project.kind === 'folder' ? [project.folderPath ?? ''] : project.repos.map((r) => r.path);
  for (const root of roots.filter(Boolean)) {
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.isFile() && /^\.env(\..+)?$/.test(e.name)) files.push(join(root, e.name));
  }
  const values: string[] = [];
  for (const file of new Set(files)) {
    try {
      const handle = await fsp.open(file, constants.O_RDONLY);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_ENV_FILE_BYTES) continue;
        values.push(...envFileValues(await handle.readFile('utf8')));
      } finally {
        await handle.close();
      }
    } catch {
      // A missing env file only means fewer values to mask; token shapes are still masked.
    }
  }
  return values;
}

/**
 * Imports every conversation of `project` found in its folders under `projectsDir`, oldest first.
 * Idempotent: a conversation the project already has is skipped.
 */
export async function importProjectSessions(
  store: Store,
  project: Project,
  options: ImportOptions,
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    project: project.name,
    dirs: [],
    notIncluded: [],
    files: 0,
    imported: [],
    skipped: { alreadyImported: 0, empty: 0, corrupt: 0, active: 0, notPlainFile: 0, unreadable: 0 },
    corruptLines: 0,
  };
  // Resolve the root once; every folder and file below is checked with lstat and never followed.
  const root = await fsp.realpath(options.projectsDir).catch(() => {
    throw new ValidationError(`Claude's projects folder ${options.projectsDir} does not exist`);
  });
  const names = await projectDirNames(project, options.alsoDirs);
  // Claude's folder names are lossy ("my.app" and "my-app" both become "my-app"): a folder that
  // another project also maps to could hold that project's conversations, so neither imports it.
  for (const other of store.projects.list()) {
    if (other.id === project.id) continue;
    const theirs = await projectDirNames(other);
    const shared = names.find((n) => theirs.includes(n));
    if (shared) {
      // Names sorted, so both projects' refusals read the same and the CLI prints it once.
      const [first, second] = [project.name, other.name].sort();
      throw new ValidationError(
        `Refused: projects "${first}" and "${second}" map to the same Claude folder name (Claude turns every character other than a letter or digit into "-"), so neither is imported from it`,
      );
    }
  }
  const allDirs = await fsp.readdir(root).catch(() => [] as string[]);
  summary.notIncluded = allDirs
    .filter((d) => !names.includes(d) && names.some((n) => d.startsWith(`${n}-`)))
    .sort();

  const files: { path: string; id: string; mtimeMs: number }[] = [];
  const seenIds = new Set<string>();
  for (const name of names) {
    const dir = join(root, name);
    const stat = await fsp.lstat(dir).catch(() => null);
    const found = stat !== null && stat.isDirectory() && !stat.isSymbolicLink();
    summary.dirs.push({ name, found });
    if (!found) continue;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const match = CONVERSATION_FILE.exec(entry.name);
      if (!match?.[1]) continue;
      summary.files++;
      if (!entry.isFile()) {
        summary.skipped.notPlainFile++; // a symlink (or a folder named *.jsonl): never followed
        continue;
      }
      const path = join(dir, entry.name);
      const fileStat = await fsp.lstat(path).catch(() => null);
      if (!fileStat?.isFile()) {
        summary.skipped.notPlainFile++;
        continue;
      }
      // The same conversation in two folders (e.g. a worktree and the repo) is one session.
      if (seenIds.has(match[1])) {
        summary.skipped.alreadyImported++;
        continue;
      }
      seenIds.add(match[1]);
      files.push({ path, id: match[1], mtimeMs: fileStat.mtimeMs });
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));

  const secrets = [...(await projectSecrets(project)), ...(options.secrets ?? [])];
  const redact = (text: string) => maskEdgeFragments(redactSecrets(text, secrets));
  const now = store.clock.now().getTime();
  const activeWindow = options.activeWindowMs ?? 5 * 60_000;
  for (const file of files) {
    if (alreadyHas(store.sessions.findByAgentSessionId(file.id), project.id)) {
      summary.skipped.alreadyImported++;
      continue;
    }
    if (activeWindow > 0 && now - file.mtimeMs < activeWindow) {
      summary.skipped.active++;
      continue;
    }
    let scan: Scan | 'not-plain';
    try {
      scan = await scanFile(file.path, options.maxChars, redact);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ELOOP' || code === 'EMLINK') summary.skipped.notPlainFile++;
      else summary.skipped.unreadable++;
      continue;
    }
    if (scan === 'not-plain') {
      summary.skipped.notPlainFile++;
      continue;
    }
    if (scan.valid === 0 && scan.corruptLines > 0) {
      summary.skipped.corrupt++;
      continue;
    }
    if (!scan.transcript) {
      summary.skipped.empty++;
      continue;
    }
    summary.corruptLines += scan.corruptLines;
    const createdAt = new Date(scan.firstAt ?? file.mtimeMs).toISOString();
    const endedAt = new Date(scan.lastAt ?? file.mtimeMs).toISOString();
    const title =
      (scan.title !== null ? makeTitle(scan.title, secrets) : '') ||
      `Imported conversation ${file.id.slice(0, 8)}`;
    const item: ImportedItem = {
      outcome: options.dryRun ? 'would import' : 'imported',
      title,
      agentSessionId: file.id,
      createdAt,
      endedAt,
      sessionId: null,
    };
    if (!options.dryRun) {
      const body = redactSecrets(scan.transcript, secrets);
      const session = store.transaction(() => {
        const s = store.sessions.importEnded({
          projectId: project.id,
          title,
          model: scan.model ?? 'unknown',
          agentSessionId: file.id,
          createdAt,
          endedAt,
        });
        if (!s) return null;
        const header = `Session ${s.id} "${title}" (imported Claude Code conversation, ${createdAt.slice(0, 10)} to ${endedAt.slice(0, 10)})`;
        store.history.add({
          projectId: project.id,
          sessionId: s.id,
          kind: 'transcript',
          text: `${header}\n\n${body}`,
        });
        return s;
      });
      if (!session) {
        summary.skipped.alreadyImported++; // imported by a parallel run in between
        continue;
      }
      item.sessionId = session.id;
    }
    summary.imported.push(item);
  }
  return summary;
}

/** In this project already, or run by the session runner (whatever its project): never imported again. */
function alreadyHas(sessions: Session[], projectId: number): boolean {
  return sessions.some((s) => s.projectId === projectId || s.source === 'runner');
}
