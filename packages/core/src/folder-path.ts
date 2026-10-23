import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { ValidationError } from './errors.js';
import type { Project, Repo } from './types.js';

export interface FolderPathCheck {
  /**
   * Folders a project folder may not be, sit inside, or contain: WORKTREES_ROOT, the runner state
   * dir, the jobs root, the server's own repo (it holds .env and the database), the database folder.
   */
  protectedRoots?: string[];
  /** Default os.homedir(). */
  home?: string;
  /** Claude's config folder (CLAUDE_CONFIG_DIR); ~/.claude is always protected too. */
  claudeConfigDir?: string;
  /** Every registered project: the folder may not equal, contain or sit inside any of their paths. */
  projects?: Project[];
  /** A folder that is, or is inside, a git work tree is refused unless this is true. */
  allowGitFolder?: boolean;
  /** A folder outside the home folder is refused unless this is true (system folders always are). */
  allowOutsideHome?: boolean;
  /** The PATH whose folders (and the folders of the agent binaries on it) are protected. Default process.env.PATH. */
  pathEnv?: string;
}

/** Folders under the home folder an agent must never edit in place (credentials, its own settings). */
export const HOME_DENYLIST = ['.claude', '.ssh', '.config', 'Library', '.gnupg', '.aws'];
/** Top-level folders under home that are never project folders (besides every dot-folder). */
const HOME_EXCLUDED = ['Library', 'Applications'];
/** System folders a folder project outside home may not overlap, even with allowOutsideHome. */
export const SYSTEM_FOLDERS = [
  '/usr',
  '/opt',
  '/etc',
  '/private',
  '/Applications',
  '/System',
  '/Library',
  '/bin',
  '/sbin',
  '/var',
  '/cores',
  '/dev',
];
/** Binaries the server runs: a folder holding one could let an agent rewrite what the server launches. */
export const PROTECTED_BINARIES = ['claude', 'opencode', 'gh', 'tmux', 'node', 'git'];

/**
 * The on-disk spelling of a path: symlinks resolved and, through realpath.native, the case the
 * filesystem stores (macOS's default filesystem is case-insensitive, so "/USERS/me" is the home
 * folder but the JS realpath keeps the typed case). A path that does not exist yet is canonicalized
 * through its nearest existing parent.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
}

/**
 * Comparison key. Paths are already canonical (on-disk case); macOS volumes are usually
 * case-insensitive, so on darwin the comparison also ignores case as a second layer.
 */
const key = (path: string) => (process.platform === 'darwin' ? path.toLowerCase() : path);

/** a and b are the same folder, or one is inside the other. Both canonical. */
export function pathsOverlap(a: string, b: string): boolean {
  const [x, y] = [key(a), key(b)];
  const inside = (root: string, p: string) => p.startsWith(root.endsWith(sep) ? root : root + sep);
  return x === y || inside(x, y) || inside(y, x);
}

/** The paths a project occupies on disk: its folder, or its repos' checkouts. */
export function projectPaths(project: Project): string[] {
  return project.kind === 'folder' && project.folderPath
    ? [project.folderPath]
    : project.repos.map((r) => r.path);
}

/**
 * Folders an agent editing in place could use to change what the server runs: every absolute PATH
 * entry, the real folders of the agent binaries found on it, and the running node's folder.
 */
function binaryFolders(pathEnv: string): { path: string; why: string }[] {
  const out: { path: string; why: string }[] = [];
  for (const dir of pathEnv.split(':')) {
    if (!isAbsolute(dir) || dir === sep) continue;
    out.push({ path: canonicalPath(dir), why: 'a folder on PATH' });
    for (const name of PROTECTED_BINARIES) {
      const bin = join(dir, name);
      if (!existsSync(bin)) continue;
      out.push({ path: dirname(canonicalPath(bin)), why: `the folder holding the ${name} binary` });
    }
  }
  out.push({ path: dirname(canonicalPath(process.execPath)), why: 'the folder holding the node binary' });
  return out;
}

/** The nearest folder at or above `path` holding a `.git` entry, or null. */
function gitWorkTree(path: string): string | null {
  for (let dir = path; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Checks a folder for a new folder project and returns its canonical path, which is what gets
 * stored. Refuses: a relative or missing path, a path with "#", anything but a directory, "/", the
 * home folder itself, credential and config folders under it (HOME_DENYLIST, Claude's config
 * folder), a folder overlapping a protected root, a folder equal to, inside or holding another
 * project's path, and a folder in a git work tree unless `allowGitFolder`. Every comparison is made
 * between canonical paths, so neither a symlink nor a different letter case gets around it.
 */
export function checkFolderProjectPath(path: string, options: FolderPathCheck = {}): string {
  if (!isAbsolute(path)) throw new ValidationError(`folder path "${path}" must be absolute`);
  if (path.includes('#')) throw new ValidationError(`folder path "${path}" may not contain "#"`);
  if (!existsSync(path)) throw new ValidationError(`folder ${path} does not exist`);
  const real = realpathSync.native(path);
  if (real.includes('#')) throw new ValidationError(`folder ${path} resolves to ${real}, which contains "#"`);
  if (!statSync(real).isDirectory()) throw new ValidationError(`${path} is not a folder`);
  if (real === sep) throw new ValidationError('the root folder "/" cannot be a project folder');
  const home = canonicalPath(options.home ?? homedir());
  if (key(real) === key(home)) {
    throw new ValidationError('your home folder itself cannot be a project folder; pick a folder inside it');
  }
  const denied = [
    ...HOME_DENYLIST.map((name) => join(home, name)),
    ...(options.claudeConfigDir ? [options.claudeConfigDir] : []),
  ].map(canonicalPath);
  for (const root of denied) {
    if (pathsOverlap(real, root)) {
      throw new ValidationError(`folder ${path} overlaps ${root}, which holds credentials or agent settings`);
    }
  }
  for (const root of (options.protectedRoots ?? []).map(canonicalPath)) {
    if (pathsOverlap(real, root)) {
      throw new ValidationError(
        `folder ${path} overlaps ${root}, which the loop server or runner owns (worktrees, state, its repo or database)`,
      );
    }
  }
  for (const project of options.projects ?? []) {
    for (const other of projectPaths(project).map(canonicalPath)) {
      if (pathsOverlap(real, other)) {
        throw new ValidationError(
          `folder ${path} overlaps project "${project.name}" (${other}); project folders may not nest`,
        );
      }
    }
  }
  // Allowlist: a plain folder inside home, with no dot-folder anywhere in its path.
  const insideHome = key(real).startsWith(key(home.endsWith(sep) ? home : home + sep));
  if (insideHome) {
    const parts = real.slice(home.length + 1).split(sep);
    const hidden = parts.find((part) => part.startsWith('.'));
    if (hidden) {
      throw new ValidationError(
        `folder ${path} is inside the hidden folder "${hidden}"; dot-folders hold tools and settings, so they cannot be project folders`,
      );
    }
    if (HOME_EXCLUDED.some((name) => key(name) === key(parts[0] ?? ''))) {
      throw new ValidationError(`folder ${path} is inside ~/${parts[0]}, which cannot hold project folders`);
    }
  } else {
    if (!options.allowOutsideHome) {
      throw new ValidationError(
        `folder ${path} is outside your home folder; pass allowOutsideHome: true if you really mean it`,
      );
    }
    for (const system of SYSTEM_FOLDERS.map(canonicalPath)) {
      if (pathsOverlap(real, system))
        throw new ValidationError(`folder ${path} overlaps the system folder ${system}`);
    }
    // /Volumes itself and each mounted disk's root.
    if (key(real) === key('/Volumes') || key(dirname(real)) === key('/Volumes')) {
      throw new ValidationError(`folder ${path} is a whole disk (or all of them); pick a folder on it`);
    }
  }
  for (const { path: dir, why } of binaryFolders(options.pathEnv ?? process.env.PATH ?? '')) {
    if (pathsOverlap(real, dir)) throw new ValidationError(`folder ${path} overlaps ${dir}, ${why}`);
  }
  const tree = options.allowGitFolder ? null : gitWorkTree(real);
  if (tree !== null) {
    throw new ValidationError(
      `${path} is ${tree === real ? 'a git repository' : `inside the git repository ${tree}`}: register ` +
        'that repository as a git project, or pass allowGitFolder: true to edit it in place',
    );
  }
  return real;
}

/**
 * A git project's repos may not overlap a folder project's folder (the folder agent would edit that
 * checkout and its .git in place). `exceptProjectId` is the project being edited.
 */
export function checkReposAgainstFolders(repos: Repo[], projects: Project[], exceptProjectId?: number): void {
  for (const repo of repos) {
    const path = canonicalPath(repo.path);
    for (const project of projects) {
      if (project.id === exceptProjectId || project.kind !== 'folder' || !project.folderPath) continue;
      if (pathsOverlap(path, canonicalPath(project.folderPath))) {
        throw new ValidationError(
          `repo ${repo.name} (${repo.path}) overlaps the folder of project "${project.name}" (${project.folderPath})`,
        );
      }
    }
  }
}
