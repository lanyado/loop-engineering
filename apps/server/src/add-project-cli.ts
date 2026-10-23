import { statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { errorMessage } from '@loop-engineering/core';

export const ADD_PROJECT_USAGE = `Usage: npm run add-project -- <path> [--name <name>] [--branch <b>] [--folder] [--outside-home]

Registers a project with the running server (start it first with \`npm start\`).

  <path>         a git repository with a GitHub remote named origin, or any folder
  --name <name>  project name (default: the folder's name)
  --branch <b>   the repo's default branch, which PRs target (default: detected)
  --folder       a plain folder project, even if <path> is a git repository: sessions edit it in
                 place, with no branches or PRs
  --outside-home allow a folder project outside your home folder (refused by default)
  -h, --help     this text`;

/** Runs git in `cwd` and returns its trimmed output, or null when it fails. */
export type Git = (args: string[], cwd: string) => string | null;

export interface AddProjectIo {
  env: Record<string, string | undefined>;
  git: Git;
  fetch: typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** What the server's POST /api/projects takes. */
export type NewProject =
  | {
      name: string;
      kind: 'git';
      repos: { name: string; path: string; remote: string; defaultBranch: string }[];
    }
  | {
      name: string;
      kind: 'folder';
      folderPath: string;
      allowGitFolder?: boolean;
      allowOutsideHome?: boolean;
    };

/** Folder names may hold any character; project and repo names only these. */
export function projectName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

/**
 * The project for `path`: a git project when it is in a git repository with an origin remote, else a
 * folder project. Throws with a message for the user when a git repository has no origin.
 */
/**
 * origin/HEAD when set (clone sets it; a repo that was `git init`ed and pushed may not have it), else
 * main or master if either exists, else the branch checked out now.
 */
function detectDefaultBranch(top: string, git: Git): string {
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], top);
  if (head) return head.replace(/^origin\//, '');
  for (const branch of ['main', 'master']) {
    for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
      if (git(['rev-parse', '--verify', '--quiet', ref], top) !== null) return branch;
    }
  }
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], top);
  return current && current !== 'HEAD' ? current : 'main';
}

export function detectProject(
  path: string,
  git: Git,
  opts: { name?: string; folder?: boolean; branch?: string },
): NewProject {
  const tree = git(['rev-parse', '--show-toplevel'], path);
  if (opts.folder || tree === null) {
    return {
      name: projectName(opts.name ?? basename(path)),
      kind: 'folder',
      folderPath: path,
      ...(tree !== null ? { allowGitFolder: true } : {}),
    };
  }
  // Sessions get worktrees of the main checkout; a linked worktree's common dir is <main>/.git.
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], tree);
  const top = common?.endsWith('/.git') ? dirname(common) : tree;
  const remote = withoutCredentials(git(['remote', 'get-url', 'origin'], top));
  if (!remote) {
    throw new Error(
      `${top} has no remote named origin. Add one (git remote add origin <GitHub URL>), or pass --folder to edit it in place.`,
    );
  }
  const defaultBranch = opts.branch ?? detectDefaultBranch(top, git);
  const name = projectName(opts.name ?? basename(top));
  return {
    name,
    kind: 'git',
    repos: [{ name: projectName(basename(top)), path: top, remote, defaultBranch }],
  };
}

/**
 * A token in an https remote (https://user:token@github.com/...) is not stored: the API returns
 * projects whole. The loop pushes to the stored URL, so it then needs a credential helper
 * (`gh auth setup-git`). ssh URLs (git@github.com:...) are kept as they are.
 */
export function withoutCredentials(remote: string | null): string | null {
  return remote?.replace(/^(https?:\/\/)[^/@]*@/, '$1') ?? null;
}

export function serverUrl(env: Record<string, string | undefined>): string {
  return (env.SERVER_URL?.trim() || `http://127.0.0.1:${env.SERVER_PORT?.trim() || '8787'}`).replace(
    /\/+$/,
    '',
  );
}

/** Runs the CLI; returns the exit code (0 added, 1 failed, 2 usage). */
export async function runAddProjectCli(argv: string[], io: AddProjectIo): Promise<number> {
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
    io.err(`${errorMessage(error)}\n\n${ADD_PROJECT_USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(ADD_PROJECT_USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    io.err(ADD_PROJECT_USAGE);
    return 2;
  }
  // npm runs scripts from the repo root; INIT_CWD is where the command was typed.
  const path = resolve(io.env.INIT_CWD ?? process.cwd(), positionals[0]!);
  try {
    if (!statSync(path).isDirectory()) throw new Error('not a folder');
  } catch {
    io.err(`${path} is not a folder.`);
    return 1;
  }
  const token = io.env.DASHBOARD_TOKEN?.trim();
  if (!token) {
    io.err('DASHBOARD_TOKEN is not set in .env. Run `npm run setup` first.');
    return 1;
  }

  let project;
  try {
    project = detectProject(path, io.git, {
      ...(values.name ? { name: values.name } : {}),
      ...(values.folder ? { folder: true } : {}),
      ...(values.branch ? { branch: values.branch } : {}),
    });
  } catch (error) {
    io.err(errorMessage(error));
    return 1;
  }

  if (values['outside-home'] && project.kind === 'folder') project.allowOutsideHome = true;

  const url = serverUrl(io.env);
  let response;
  try {
    response = await io.fetch(`${url}/api/projects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(project),
    });
  } catch {
    io.err(`Cannot reach the server at ${url}. Start it with \`npm start\`, then run this again.`);
    return 1;
  }
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok) {
    // The API names its own fields; point at this CLI's flags instead.
    const why = (typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
      .replace('pass allowOutsideHome: true', 'pass --outside-home')
      .replace('pass allowGitFolder: true', 'pass --folder');
    io.err(`The server refused the project: ${why}`);
    return 1;
  }

  const where = project.kind === 'git' ? project.repos[0]!.path : project.folderPath;
  const remote = project.kind === 'git' ? project.repos[0]!.remote : '';
  io.out(
    project.kind === 'git'
      ? `✓ Added git project "${project.name}" (${remote}, default branch ${project.repos[0]!.defaultBranch}; --branch changes it).`
      : `✓ Added folder project "${project.name}" (${where}).`,
  );
  io.out(
    `Once: cd ${where} && claude, and accept "Yes, I trust this folder" (sessions can't start until you do).`,
  );
  const raw = project.kind === 'git' ? io.git(['remote', 'get-url', 'origin'], where) : null;
  if (raw && raw !== remote) {
    io.out(
      'Note: the token in the origin URL was left out; run `gh auth setup-git` so the PR loop can push.',
    );
  }
  if (remote && !/github\.com[:/]/.test(remote)) {
    io.out('Note: the PR loop works with GitHub remotes only; sessions still run on this repo.');
  }
  io.out('Then press + Session on the project in the dashboard.');
  return 0;
}
