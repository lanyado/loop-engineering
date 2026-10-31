// In-memory fakes for the runner's drivers. Exported so other packages' tests can drive a runner.
import type { Fs } from './drivers/fs.js';
import type { GitDriver } from './drivers/git.js';
import type { NewWindow, TmuxDriver, TmuxWindow } from './drivers/tmux.js';

/** The bottom of an idle Claude Code screen: an empty input box. New fake windows start with it. */
export const IDLE_CLAUDE_PANE = ['────────────────', '❯ ', '────────────────', '  ? for shortcuts'].join(
  '\n',
);

export interface FakeWindow extends NewWindow {
  target: string;
  /** What capture() returns; set it to simulate agent output. */
  output: string;
  /** Text sent with sendKeys, Enter recorded as "\n". */
  keys: string;
  /** Simulates remain-on-exit: the process exited but the window stayed. */
  dead: boolean;
}

export class FakeTmuxDriver implements TmuxDriver {
  readonly windows = new Map<string, FakeWindow>();
  readonly killed: string[] = [];
  private nextId = 1;

  newWindow(spec: NewWindow): Promise<string> {
    const target = `${spec.session}:@${this.nextId++}`;
    this.windows.set(target, { ...spec, target, output: IDLE_CLAUDE_PANE, keys: '', dead: false });
    return Promise.resolve(target);
  }

  sendKeys(target: string, text: string, options: { enter?: boolean } = {}): Promise<void> {
    this.require(target).keys += text + ((options.enter ?? true) ? '\n' : '');
    return Promise.resolve();
  }

  capture(target: string): Promise<string> {
    const w = this.windows.get(target);
    return w ? Promise.resolve(w.output) : Promise.reject(new Error(`can't find window: ${target}`));
  }

  kill(target: string): Promise<void> {
    if (this.windows.delete(target)) this.killed.push(target);
    return Promise.resolve();
  }

  list(session: string): Promise<TmuxWindow[]> {
    return Promise.resolve(
      [...this.windows.values()]
        .filter((w) => w.session === session)
        .map((w) => ({ target: w.target, name: w.name, dead: w.dead })),
    );
  }

  /** Sets the pane text of `target`. */
  print(target: string, output: string): void {
    this.require(target).output = output;
  }

  private require(target: string): FakeWindow {
    const w = this.windows.get(target);
    if (!w) throw new Error(`can't find window: ${target}`);
    return w;
  }
}

interface FakeWorktree {
  repoPath: string;
  branch: string;
}

export class FakeGitDriver implements GitDriver {
  readonly worktrees = new Map<string, FakeWorktree>();
  /** Branches per repo checkout path. */
  readonly branches = new Map<string, Set<string>>();
  /** `git status --short` per worktree path; non-empty means dirty. */
  readonly statuses = new Map<string, string>();
  readonly commits = new Map<string, string[]>();
  /** Tracked paths per checkout path (worktree or repo), relative to it. */
  readonly tracked = new Map<string, Set<string>>();
  readonly pushed: { path: string; branch: string }[] = [];
  /** Repo paths whose addWorktree fails, to test rollback. */
  readonly failAddFor = new Set<string>();
  readonly fetched: { repoPath: string; ref: string }[] = [];
  /** Repo paths whose fetch fails, like an unreachable remote. */
  readonly failFetchFor = new Set<string>();
  /** The base ref each worktree was created from. */
  readonly bases = new Map<string, string>();

  /** With an Fs, worktree directories appear in and vanish from it like on disk. */
  constructor(private readonly fs?: Fs) {}

  fetch(repoPath: string, ref: string): Promise<void> {
    if (this.failFetchFor.has(repoPath))
      return Promise.reject(new Error(`fatal: unable to access ${repoPath}`));
    this.fetched.push({ repoPath, ref });
    return Promise.resolve();
  }

  async addWorktree(repoPath: string, worktreePath: string, branch: string, baseRef: string): Promise<void> {
    if (this.failAddFor.has(repoPath)) throw new Error(`fatal: cannot add worktree in ${repoPath}`);
    if (this.worktrees.has(worktreePath)) throw new Error(`fatal: '${worktreePath}' already exists`);
    const branches = this.branches.get(repoPath) ?? new Set([baseRef]);
    if (branches.has(branch)) throw new Error(`fatal: a branch named '${branch}' already exists`);
    branches.add(branch);
    this.branches.set(repoPath, branches);
    this.worktrees.set(worktreePath, { repoPath, branch });
    this.bases.set(worktreePath, baseRef);
    await this.fs?.mkdir(worktreePath);
  }

  async removeWorktree(
    _repoPath: string,
    worktreePath: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (!this.worktrees.has(worktreePath)) throw new Error(`fatal: '${worktreePath}' is not a working tree`);
    if (!options.force && (this.statuses.get(worktreePath) ?? '') !== '') {
      throw new Error(
        `fatal: '${worktreePath}' contains modified or untracked files, use --force to delete it`,
      );
    }
    this.worktrees.delete(worktreePath);
    await this.fs?.remove(worktreePath);
  }

  branchExists(repoPath: string, branch: string): Promise<boolean> {
    return Promise.resolve(this.branches.get(repoPath)?.has(branch) ?? false);
  }

  isTracked(path: string, relPath: string): Promise<boolean> {
    const prefix = relPath.endsWith('/') ? relPath : `${relPath}/`;
    const files = [...(this.tracked.get(path) ?? [])];
    return Promise.resolve(files.some((f) => f === relPath || f.startsWith(prefix)));
  }

  deleteBranch(repoPath: string, branch: string): Promise<void> {
    this.branches.get(repoPath)?.delete(branch);
    return Promise.resolve();
  }

  currentBranch(path: string): Promise<string> {
    const wt = this.worktrees.get(path);
    return wt ? Promise.resolve(wt.branch) : Promise.reject(new Error(`not a git repository: ${path}`));
  }

  status(path: string): Promise<string> {
    return Promise.resolve(this.statuses.get(path) ?? '');
  }

  diffStat(path: string): Promise<string> {
    const status = this.statuses.get(path) ?? '';
    return Promise.resolve(status ? ` ${status.split('\n').length} files changed` : '');
  }

  recentCommits(path: string, count: number): Promise<string[]> {
    return Promise.resolve((this.commits.get(path) ?? []).slice(0, count));
  }

  push(path: string, branch: string): Promise<void> {
    this.pushed.push({ path, branch });
    return Promise.resolve();
  }

  excludeFile(path: string): Promise<string> {
    const wt = this.worktrees.get(path);
    return Promise.resolve(`${wt?.repoPath ?? path}/.git/info/exclude`);
  }
}

export interface MemoryFile {
  content: string;
  mode?: number;
}

export class MemoryFs implements Fs {
  readonly files = new Map<string, MemoryFile>();
  readonly dirs = new Set<string>();
  /** Paths that are symlinks (writeFileNoFollow refuses them). */
  readonly symlinks = new Set<string>();
  /** realpath() answers: path -> what it resolves to (a symlink target or another letter case). */
  readonly realpaths = new Map<string, string>();

  constructor(files: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(files)) this.files.set(path, { content });
  }

  exists(path: string): Promise<boolean> {
    const prefix = `${path}/`;
    const found =
      this.files.has(path) ||
      this.dirs.has(path) ||
      [...this.files.keys(), ...this.dirs].some((p) => p.startsWith(prefix));
    return Promise.resolve(found);
  }

  readFile(path: string): Promise<string> {
    const file = this.files.get(path);
    return file ? Promise.resolve(file.content) : Promise.reject(new Error(`ENOENT: ${path}`));
  }

  writeFile(path: string, content: string, options: { mode?: number } = {}): Promise<void> {
    this.files.set(path, { content, mode: options.mode });
    return Promise.resolve();
  }

  async copyFile(source: string, target: string, options: { mode?: number } = {}): Promise<void> {
    await this.writeFile(target, await this.readFile(source), options);
  }

  mkdir(path: string): Promise<void> {
    this.dirs.add(path);
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    const prefix = `${path}/`;
    for (const p of [...this.files.keys()]) if (p === path || p.startsWith(prefix)) this.files.delete(p);
    for (const d of [...this.dirs]) if (d === path || d.startsWith(prefix)) this.dirs.delete(d);
    return Promise.resolve();
  }

  list(path: string): Promise<string[]> {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.dirs]) {
      if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0] ?? '');
    }
    names.delete('');
    return names.size > 0 || this.dirs.has(path)
      ? Promise.resolve([...names])
      : Promise.reject(new Error(`ENOENT: ${path}`));
  }

  async realpath(path: string): Promise<string> {
    if (!(await this.exists(path))) throw new Error(`ENOENT: ${path}`);
    return this.realpaths.get(path) ?? path;
  }

  writeFileNoFollow(dir: string, name: string, content: string, mode: number): Promise<void> {
    const path = `${dir}/${name}`;
    for (const p of [dir, path]) {
      if (this.symlinks.has(p)) {
        return Promise.reject(
          Object.assign(new Error(`refusing to write through the symlink ${p}`), { code: 'ELOOP' }),
        );
      }
    }
    this.dirs.add(dir);
    return this.writeFile(path, content, { mode });
  }

  /** Content of `path`; throws when missing. */
  read(path: string): string {
    const file = this.files.get(path);
    if (!file) throw new Error(`ENOENT: ${path}`);
    return file.content;
  }
}
