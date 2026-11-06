import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { envFileValues, errorMessage, secretValues } from '@loop-engineering/core';
import {
  collectRetro,
  renderRetro,
  retroFileName,
  retroRequestText,
  windowFromFlags,
  type RetroData,
} from '@loop-engineering/history';
import { apiError, callServer, serverUrl, type AddProjectIo, type ServerIo } from './add-project-cli.js';
import { fromRoot } from './env.js';

export const RETRO_USAGE = `Usage: loop retro [--since <date>] [--until <date> | --days <n>] [--project <name|id>] [options]

Mines the loop's database for one window and writes a Markdown report: sessions, pauses, PRs and
their fix rounds, stage failures and their most common reasons, questions to humans and how long
they waited, requests that never finished, and the top recurring problems with their evidence.
Read-only on the database; no model and no network (unless --file-request).

  --since <date>      first day (YYYY-MM-DD, UTC) or an ISO time (default: the previous month)
  --until <date>      last day, included (default with --since: now)
  --days <n>          the last n days instead
  --project <p>       one project, by name or id (default: all)
  --db <path>         database (default LOOP_DB_PATH, or ./data/loop.db in the repo; a relative
                      --db is from the current folder, like --out-dir)
  --out-dir <dir>     where to write (default: retros/ beside the database)
  --stdout            print the report instead of writing the file
  --file-request      also file the report as a request asking a builder to propose pipeline and
                      prompt improvements (needs --project and the server running; off by default)
  --request-project <p>  the project that request goes to (default: --project)
  -h, --help          this text

The file is <dir>/<YYYY-MM>.md for a calendar month, else <first>_to_<last>.md; a report of one
project ends in -<project>. Its path is printed.`;

/** Older databases lack columns the report reads (sessions.rigor came with migration 21). */
const MIN_SCHEMA = 21;

export type RetroCliIo = Pick<AddProjectIo, 'env' | 'fetch' | 'out' | 'err'> & {
  /** For tests: "now". */
  now?: () => Date;
};

interface KnownProject {
  id: number;
  name: string;
}

/** A project by exact name, else by id. */
const findProject = <T extends KnownProject>(projects: T[], wanted: string): T | undefined =>
  projects.find((p) => p.name === wanted) ??
  (/^\d+$/.test(wanted) ? projects.find((p) => p.id === Number(wanted)) : undefined);

/**
 * Values to mask besides token shapes, as history search does: the server's secret env values and
 * the secret values in the env files of the projects the report covers. An unreadable file is skipped.
 */
function knownSecrets(db: Database.Database, env: RetroCliIo['env'], projectId?: number): string[] {
  const values = secretValues(env);
  const rows = db
    .prepare('SELECT env_files FROM projects WHERE ? IS NULL OR id = ?')
    .all(projectId ?? null, projectId ?? null) as { env_files: string }[];
  for (const row of rows) {
    let files: unknown;
    try {
      files = JSON.parse(row.env_files);
    } catch {
      continue;
    }
    for (const f of Array.isArray(files) ? files : []) {
      const source = (f as { source?: unknown } | null)?.source;
      if (typeof source !== 'string') continue;
      try {
        values.push(...envFileValues(readFileSync(source, 'utf8')));
      } catch {
        // Token shapes and the server's secrets still apply.
      }
    }
  }
  return values;
}

const quiet = (d: RetroData) =>
  d.sessions.started + d.prs.opened + d.requests.created + d.questions.asked === 0;

/** `loop retro`; returns the exit code (0 done, 1 failed, 2 usage). */
export async function runRetroCli(argv: string[], io: RetroCliIo): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        since: { type: 'string' },
        until: { type: 'string' },
        days: { type: 'string' },
        project: { type: 'string' },
        db: { type: 'string' },
        'out-dir': { type: 'string' },
        stdout: { type: 'boolean' },
        'file-request': { type: 'boolean' },
        'request-project': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    io.err(`${errorMessage(error)}\n\n${RETRO_USAGE}`);
    return 2;
  }
  if (args.help) {
    io.out(RETRO_USAGE);
    return 0;
  }
  // A report of every project would carry the others' request and question snippets to one
  // project's builder: filing it needs --project.
  if (args['file-request'] && args.project === undefined) {
    io.err(
      `--file-request needs --project: the request carries the report to that project's builder.\n\n${RETRO_USAGE}`,
    );
    return 2;
  }
  const cwd = io.env.INIT_CWD ?? process.cwd();
  const now = io.now?.() ?? new Date();
  let window;
  try {
    window = windowFromFlags(args, now);
  } catch (error) {
    io.err(`${errorMessage(error)}\n\n${RETRO_USAGE}`);
    return 2;
  }
  // --db is a path typed here (like --out-dir); LOOP_DB_PATH is the server's setting, from the repo root.
  const dbPath = args.db ? resolve(cwd, args.db) : fromRoot(io.env.LOOP_DB_PATH?.trim() || './data/loop.db');
  if (dbPath === ':memory:' || !existsSync(dbPath)) {
    io.err(`No database at ${dbPath}. Start the server once, or pass --db.`);
    return 1;
  }

  let data: RetroData;
  let secrets: string[];
  let db: Database.Database | null = null;
  try {
    // Read-only: never migrates or writes the live database, even while the server runs.
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version < MIN_SCHEMA) {
      io.err(`The database is at schema ${version}; start the server on this build once to update it.`);
      return 1;
    }
    let projectId: number | undefined;
    if (args.project !== undefined) {
      const projects = db.prepare('SELECT id, name FROM projects ORDER BY id').all() as KnownProject[];
      const found = findProject(projects, args.project);
      if (!found) {
        io.err(`No project "${args.project}". Projects: ${projects.map((p) => p.name).join(', ') || 'none'}`);
        return 1;
      }
      projectId = found.id;
    }
    data = collectRetro(db, { window, now, ...(projectId === undefined ? {} : { projectId }) });
    secrets = knownSecrets(db, io.env, projectId);
  } catch (error) {
    io.err(`retro failed: ${errorMessage(error)}`);
    return 1;
  } finally {
    db?.close();
  }

  const report = renderRetro(data, { secrets });
  const fileName = retroFileName(window, data.project ?? undefined);
  if (args.stdout) io.out(report.trimEnd());
  else {
    const dir = args['out-dir'] ? resolve(cwd, args['out-dir']) : join(dirname(dbPath), 'retros');
    const path = join(dir, fileName);
    try {
      mkdirSync(dir, { recursive: true });
      // Written whole, then renamed: a reader never sees half a report. The mode only applies to a
      // new file, so a temp file left by a crash goes first, and the mode is set again to be sure.
      const tmp = `${path}.tmp`;
      rmSync(tmp, { force: true });
      writeFileSync(tmp, report, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } catch (error) {
      io.err(`Could not write ${path}: ${errorMessage(error)}`);
      return 1;
    }
    io.out(path);
  }
  if (!args['file-request']) return 0;
  // With --stdout, stdout is the report alone: what the request step says goes to stderr.
  const say = args.stdout ? io.err : io.out;
  const target = args['request-project'] ?? args.project!;
  return fileRequest(data, report, fileName, target, secrets, { ...io, out: say });
}

/** POST /api/requests, as the dashboard does: the request text and the report as an attached file. */
async function fileRequest(
  data: RetroData,
  report: string,
  fileName: string,
  target: string,
  secrets: readonly string[],
  io: RetroCliIo,
): Promise<number> {
  if (quiet(data)) {
    io.err('Nothing happened in this window, so no request was filed.');
    return 0;
  }
  const token = io.env.DASHBOARD_TOKEN?.trim();
  if (!token) {
    io.err(
      "--file-request needs DASHBOARD_TOKEN in loop-engineering's .env. Run `npm run setup` there first.",
    );
    return 1;
  }
  const server: ServerIo = { ...io, git: () => null, url: serverUrl(io.env), token };
  const list = await callServer(server, 'GET', '/projects');
  if (!list) return 1;
  if (list.status !== 200 || !Array.isArray(list.body.projects)) {
    io.err(`The server did not list its projects: ${apiError(list)}`);
    return 1;
  }
  const projects = list.body.projects as KnownProject[];
  const project = findProject(projects, target);
  if (!project) {
    io.err(`The server has no project "${target}".`);
    return 1;
  }
  const res = await callServer(server, 'POST', '/requests', {
    projectId: project.id,
    text: retroRequestText(data, fileName, { secrets }),
    attachments: [{ name: fileName, data: Buffer.from(report, 'utf8').toString('base64') }],
  });
  if (!res) return 1;
  const request = res.body.request as { id?: unknown } | undefined;
  if (res.status !== 201 || typeof request?.id !== 'number') {
    io.err(`The server did not take the request: ${apiError(res)}`);
    return 1;
  }
  io.out(
    `Filed request ${request.id} in ${project.name}: a builder will propose improvements from the retro.`,
  );
  return 0;
}
