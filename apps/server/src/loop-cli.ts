import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { errorMessage } from '@loop-engineering/core';
import {
  addProject,
  apiError,
  callServer,
  detectProject,
  serverUrl,
  type AddProjectIo,
  type NewProject,
  type ServerIo,
} from './add-project-cli.js';

export const LOOP_USAGE = `Usage: loop init [<path>] [--name <name>] [--branch <b>] [--folder] [--outside-home]

Gives the project in <path> (default: this folder) its own pipeline: a .loop-engineering/ folder
there, starting as a copy of the shared pipeline. The dashboard's pencil then has a tab for the
project, where you choose its stages, their order and their prompts; the loop runs its PRs through
them. A folder the server does not know yet is added as a project first (like \`npm run add-project\`),
so the server must be running (\`npm start\`). Running it again changes nothing.

  --name <name>  project name, when it is added (default: the folder's name)
  --branch <b>   the repo's default branch, when it is added (default: detected)
  --folder       add it as a plain folder project, even if <path> is a git repository
  --outside-home allow a folder project outside your home folder (refused by default)
  -h, --help     this text`;

interface KnownProject {
  id: number;
  name: string;
  kind: 'git' | 'folder';
  folderPath: string | null;
  repos: { path: string }[];
}

/** The project the server already has for this folder: the same repo checkout, or the same folder. */
function findProject(projects: KnownProject[], wanted: NewProject): KnownProject | undefined {
  if (wanted.kind === 'git') {
    const top = wanted.repos[0]!.path;
    return projects.find((p) => p.kind === 'git' && p.repos.some((r) => r.path === top));
  }
  // The server stores a folder project's path without symlinks.
  let path = wanted.folderPath;
  try {
    path = realpathSync(path);
  } catch {
    // Checked to exist already; compare as given.
  }
  return projects.find((p) => p.kind === 'folder' && p.folderPath === path);
}

/** `loop <command>`; returns the exit code (0 done, 1 failed, 2 usage). */
export async function runLoopCli(argv: string[], io: AddProjectIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        name: { type: 'string' },
        branch: { type: 'string' },
        folder: { type: 'boolean' },
        'outside-home': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    io.err(`${errorMessage(error)}\n\n${LOOP_USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help || positionals[0] === 'help') {
    io.out(LOOP_USAGE);
    return 0;
  }
  if (positionals[0] !== 'init' || positionals.length > 2) {
    io.err(LOOP_USAGE);
    return 2;
  }
  // npm runs scripts from the repo root; INIT_CWD is where the command was typed.
  const path = resolve(io.env.INIT_CWD ?? process.cwd(), positionals[1] ?? '.');
  try {
    if (!statSync(path).isDirectory()) throw new Error('not a folder');
  } catch {
    io.err(`${path} is not a folder.`);
    return 1;
  }
  const token = io.env.DASHBOARD_TOKEN?.trim();
  if (!token) {
    io.err("DASHBOARD_TOKEN is not set in loop-engineering's .env. Run `npm run setup` there first.");
    return 1;
  }
  let wanted;
  try {
    wanted = detectProject(path, io.git, {
      ...(values.name ? { name: values.name } : {}),
      ...(values.folder ? { folder: true } : {}),
      ...(values.branch ? { branch: values.branch } : {}),
    });
  } catch (error) {
    io.err(errorMessage(error));
    return 1;
  }
  if (values['outside-home'] && wanted.kind === 'folder') wanted.allowOutsideHome = true;

  const server: ServerIo = { ...io, url: serverUrl(io.env), token };
  const list = await callServer(server, 'GET', '/projects');
  if (!list) return 1;
  if (list.status !== 200 || !Array.isArray(list.body.projects)) {
    io.err(`The server did not list its projects: ${apiError(list)}`);
    return 1;
  }
  const known = findProject(list.body.projects as KnownProject[], wanted);
  const id = known?.id ?? (await addProject(wanted, server));
  if (id === null) return 1;
  const name = known?.name ?? wanted.name;

  const init = await callServer(server, 'POST', `/pipeline?project=${id}`);
  if (!init) return 1;
  const project = init.body.project as { dir?: unknown } | undefined;
  if ((init.status !== 200 && init.status !== 201) || typeof project?.dir !== 'string') {
    io.err(`The server could not give ${name} its own pipeline: ${apiError(init)}`);
    return 1;
  }
  if (init.body.created !== true) {
    io.out(`${name} already has its own pipeline in ${project.dir}; it was left as it is.`);
    return 0;
  }
  io.out(`✓ ${name} has its own pipeline now, in ${project.dir} (a copy of the shared one).`);
  io.out(
    `Edit it on the dashboard's pencil, in the "${name}" tab, or by hand. Delete the folder to go back to the shared pipeline.`,
  );
  return 0;
}
