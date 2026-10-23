import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  errorMessage,
  openStore,
  redactSecrets,
  secretValues,
  ValidationError,
  type Store,
} from '@loop-engineering/core';
import { defaultProjectsDir, importProjectSessions, type ImportSummary } from '@loop-engineering/history';
import { routerProjectId } from '@loop-engineering/router';
import { fromRoot } from './env.js';

export const IMPORT_USAGE = `Usage: npm run import-sessions -w @loop-engineering/server -- --project <name> [options]

Imports the project's past Claude Code conversations as ended sessions, each with a searchable,
redacted transcript. Read-only on Claude's folder. Safe to run again: nothing is imported twice.

  --project <name>      registered project (repeat for several)
  --claude-dir <path>   Claude's config folder (default $CLAUDE_CONFIG_DIR or ~/.claude); conversations
                        are read from <path>/projects
  --also-dir=<name>     another folder of this project's conversations, e.g. a worktree's: a folder
                        name under <claude dir>/projects (they start with "-", so write
                        --also-dir=-Users-me-app-wt), or the absolute path Claude ran in (repeat)
  --db <path>           database (default LOOP_DB_PATH, or ./data/loop.db in the repo)
  --dry-run             read and count only; store nothing
  --include-active      also import conversations changed in the last 5 minutes (normally skipped
                        as still in progress)
  --quiet               print counts only, no titles
  -h, --help            this text

Output: counts, folder names and each imported session's title (the redacted first words of the
conversation, so they appear on screen). Use --quiet to leave titles out. Transcript text is never
printed.

Large files are streamed, but each line is read whole: a file with very long lines (a pasted file in
a tool result) needs memory of a few times its longest line while it is read. A message over 1 MB
keeps only its first and last 256 KB in the transcript. A file that cannot be read at all is
skipped and counted as unreadable.`;

const OPTIONS = {
  project: { type: 'string', multiple: true },
  'claude-dir': { type: 'string' },
  'also-dir': { type: 'string', multiple: true },
  db: { type: 'string' },
  'dry-run': { type: 'boolean' },
  'include-active': { type: 'boolean' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

/**
 * Claude's folder names start with "-", which parseArgs takes for an option: "--also-dir -Users-x"
 * becomes "--also-dir=-Users-x" unless the next word is one of our own options.
 */
function joinDashValues(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const next = argv[i + 1];
    const takesValue =
      arg === '--also-dir' || arg === '--claude-dir' || arg === '--project' || arg === '--db';
    if (
      takesValue &&
      next?.startsWith('-') &&
      !(next.replace(/^--?/, '').split('=')[0]! in OPTIONS) &&
      next !== '-h'
    ) {
      out.push(`${arg}=${next}`);
      i++;
    } else out.push(arg);
  }
  return out;
}

/** One line for any failure: the error's class or code and a short, redacted message, never a stack. */
export function safeErrorLine(error: unknown): string {
  const name =
    error instanceof ValidationError
      ? ''
      : `import failed: ${error instanceof Error ? error.name : typeof error}`;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const raw = errorMessage(error);
  const message = redactSecrets(raw)
    .split('\n')[0]!
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .trim();
  const short = message.length > 240 ? `${message.slice(0, 239)}…` : message;
  if (!name) return short;
  return `${name}${code ? ` (${String(code)})` : ''}${short ? `: ${short}` : ''}`;
}

export interface ImportCliIo {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** For tests: replaces the importer. */
  importSessions?: typeof importProjectSessions;
}

/** Runs the importer CLI; returns the exit code (0 done, 1 failed, 2 usage). */
export async function runImportCli(argv: string[], io: ImportCliIo): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: joinDashValues(argv),
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    io.err(`${errorMessage(error)}\n\n${IMPORT_USAGE}`);
    return 2;
  }
  if (args.help) {
    io.out(IMPORT_USAGE);
    return 0;
  }
  const projects = args.project ?? [];
  if (projects.length === 0) {
    io.err(`--project is required\n\n${IMPORT_USAGE}`);
    return 2;
  }
  const dbPath = fromRoot(args.db ?? (io.env.LOOP_DB_PATH?.trim() || './data/loop.db'));
  // Never create a fresh database by accident: it would have no projects anyway.
  if (!existsSync(dbPath)) {
    io.err(`No database at ${dbPath}. Start the server once, or pass --db.`);
    return 1;
  }
  const claudeDir = args['claude-dir'];
  const projectsDir = claudeDir ? join(claudeDir, 'projects') : defaultProjectsDir(io.env);

  const importSessions = io.importSessions ?? importProjectSessions;
  let store: Store | null = null;
  try {
    store = openStore({ path: dbPath });
    const reserved = routerProjectId(store);
    // Check every name before importing anything.
    const targets = projects.map((name) => {
      const project = store?.projects.getByName(name);
      if (!project || project.id === reserved) {
        const known = (store?.projects.list() ?? []).filter((p) => p.id !== reserved).map((p) => p.name);
        throw new ValidationError(
          `No project named "${name}". Registered projects: ${known.join(', ') || 'none'}`,
        );
      }
      return project;
    });
    let failed = false;
    const printed = new Set<string>();
    for (const project of targets) {
      // One project's failure (e.g. a shared Claude folder) does not stop the others.
      try {
        const summary = await importSessions(store, project, {
          projectsDir,
          alsoDirs: args['also-dir'] ?? [],
          dryRun: args['dry-run'] ?? false,
          secrets: secretValues(io.env),
          ...(args['include-active'] ? { activeWindowMs: 0 } : {}),
        });
        for (const line of formatSummary(summary, args['dry-run'] ?? false, args.quiet ?? false))
          io.out(line);
      } catch (error) {
        // Our own refusals name the projects already; a refusal shared by two projects prints once.
        const line =
          error instanceof ValidationError
            ? safeErrorLine(error)
            : `Project ${project.name}: ${safeErrorLine(error)}`;
        if (!printed.has(line)) io.err(line);
        printed.add(line);
        failed = true;
      }
    }
    return failed ? 1 : 0;
  } catch (error) {
    io.err(safeErrorLine(error));
    return 1;
  } finally {
    try {
      store?.close();
    } catch {
      // Closing cannot fail in a way that matters after the work is done.
    }
  }
}

/** Counts, folder names and redacted titles only: never transcript text. */
export function formatSummary(s: ImportSummary, dryRun: boolean, quiet = false): string[] {
  const lines = [`Project ${s.project}${dryRun ? ' (dry run: nothing stored)' : ''}`];
  for (const d of s.dirs) lines.push(`  folder ${d.name}${d.found ? '' : ' (not found)'}`);
  if (!quiet) {
    for (const item of s.imported)
      lines.push(`  ${dryRun ? '~' : '+'} ${item.createdAt.slice(0, 10)}  ${redactSecrets(item.title)}`);
  }
  const k = s.skipped;
  lines.push(
    `  ${dryRun ? 'would import' : 'imported'} ${s.imported.length} of ${s.files} file(s); skipped: ` +
      `already imported ${k.alreadyImported}, empty ${k.empty}, corrupt ${k.corrupt}, ` +
      `in progress ${k.active}, not a plain file ${k.notPlainFile}, unreadable ${k.unreadable}`,
  );
  if (s.corruptLines > 0) lines.push(`  damaged lines left out of imported transcripts: ${s.corruptLines}`);
  if (s.notIncluded.length > 0) {
    lines.push(
      `  not read (add with --also-dir if they belong to ${s.project}): ${s.notIncluded.join(', ')}`,
    );
  }
  return lines;
}
