import { isAbsolute, resolve } from 'node:path';
import { gitEnvironment } from '../agent-env.js';
import { exec, ExecError } from './exec.js';

/** An unreachable remote must not stall a session start. */
const FETCH_TIMEOUT_MS = 30_000;

export interface GitDriver {
  /** `git fetch --quiet origin <ref>` in the repo checkout, updating `origin/<ref>`. Rejects when it fails or times out. */
  fetch(repoPath: string, ref: string): Promise<void>;
  /** `git worktree add --no-track -b <branch> -- <worktreePath> <baseRef>` in the repo checkout at `repoPath`. */
  addWorktree(repoPath: string, worktreePath: string, branch: string, baseRef: string): Promise<void>;
  removeWorktree(repoPath: string, worktreePath: string, options?: { force?: boolean }): Promise<void>;
  branchExists(repoPath: string, branch: string): Promise<boolean>;
  deleteBranch(repoPath: string, branch: string): Promise<void>;
  currentBranch(path: string): Promise<string>;
  /** `git status --short` output; empty when clean. */
  status(path: string): Promise<string>;
  /** `git diff HEAD --stat` output. */
  diffStat(path: string): Promise<string>;
  /** Newest first, "<short sha> <subject>". */
  recentCommits(path: string, count: number): Promise<string[]>;
  /** How many commits HEAD has that `ref` does not. */
  commitsAhead(path: string, ref: string): Promise<number>;
  /** True when `relPath` (a file, or any file under a folder) is tracked in the checkout at `path`. */
  isTracked(path: string, relPath: string): Promise<boolean>;
  push(path: string, branch: string): Promise<void>;
  /** Absolute path of the info/exclude file that applies to `path` (shared by all worktrees of a repo). */
  excludeFile(path: string): Promise<string>;
}

/**
 * On every git command the runner runs: no hooks, no fsmonitor, no ext:: transport, no submodule
 * recursion, no signature checks (gpg.program). The rest of what a repo's own config could make
 * git run is handled per command by repoConfigGuard().
 */
export const SAFE_GIT = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'submodule.recurse=false',
  '-c',
  'diff.ignoreSubmodules=all',
  '-c',
  'status.submoduleSummary=false',
  '-c',
  'fetch.recurseSubmodules=false',
  '-c',
  'push.recurseSubmodules=no',
  '-c',
  'log.showSignature=false',
  '-c',
  'core.askPass=',
] as const;

/**
 * Repo config (local or worktree scope: what an agent can write into the .git its worktree shares)
 * that makes git run a command. Overridden on the command line: emptied (a filter with no command
 * is skipped), or for credential helpers and core.sshCommand set back to what the user's own
 * (system and global) config says. Config git reads "first wins" (remote.*.receivepack, url.*.insteadOf)
 * cannot be overridden this way; whatever it runs gets only the git environment, no server secret.
 */
const OVERRIDDEN =
  /^(filter\..+\.(clean|smudge|process)|credential\.(.+\.)?helper|core\.sshcommand|diff\.external|diff\..+\.(textconv|command)|merge\..+\.driver|gpg\.(.+\.)?program|core\.pager|pager\..+|core\.editor|sequence\.editor)$/i;
/** Filters made empty must not be required, or git refuses the file. */
const FILTER_DRIVER = /^filter\.(.+)\.(clean|smudge|process)$/i;

interface ConfigEntry {
  scope: string;
  key: string;
  value: string;
}

/** `git config --list --show-scope -z`: "scope\0key\nvalue\0" per entry ("scope\0key\0" for a bare boolean). */
export function parseConfigList(out: string): ConfigEntry[] {
  const parts = out.split('\0');
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i]!;
    const kv = parts[i + 1]!;
    const nl = kv.indexOf('\n');
    entries.push({
      scope,
      key: nl < 0 ? kv : kv.slice(0, nl),
      value: nl < 0 ? 'true' : kv.slice(nl + 1),
    });
  }
  return entries;
}

/** The -c overrides that neutralize the repo's own command-running config. Pure; exported for tests. */
export function repoConfigGuard(entries: ConfigEntry[]): string[] {
  const repo = entries.filter((e) => e.scope === 'local' || e.scope === 'worktree');
  const user = entries.filter((e) => e.scope === 'system' || e.scope === 'global');
  const overrides: string[] = [];
  const seen = new Set<string>();
  for (const { key } of repo) {
    if (seen.has(key) || key.includes('=') || !OVERRIDDEN.test(key)) continue;
    seen.add(key);
    // An empty value resets a list (credential.helper) and empties a command; the user's own values follow.
    overrides.push('-c', `${key}=`);
    const own = user.filter((e) => e.key === key).map((e) => e.value);
    const lower = key.toLowerCase();
    if (lower === 'core.sshcommand' && own.length === 0) own.push('ssh');
    if (lower === 'core.pager' && own.length === 0) own.push('cat');
    for (const value of own) overrides.push('-c', `${key}=${value}`);
    const filter = FILTER_DRIVER.exec(key)?.[1];
    if (filter && !seen.has(`filter.${filter}.required`)) {
      seen.add(`filter.${filter}.required`);
      overrides.push('-c', `filter.${filter}.required=false`);
    }
  }
  return overrides;
}

export interface RealGitOptions {
  bin?: string;
  /** Where the git environment (gitEnvironment) is read from. Default process.env. */
  sourceEnv?: Record<string, string | undefined>;
}

/**
 * git for the runner, in the builders' repos and worktrees. An agent can write its repo's config
 * and hooks (the .git a worktree shares), and the runner's git runs as the user: so every command
 * runs with SAFE_GIT, the repo's command-running config neutralized (repoConfigGuard), and a
 * clean environment (gitEnvironment: no server secrets, so nothing git does run can read them).
 */
export class RealGitDriver implements GitDriver {
  private readonly bin: string;
  /** Exactly this, nothing from process.env. */
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: RealGitOptions | string = {}) {
    const o = typeof options === 'string' ? { bin: options } : options;
    this.bin = o.bin ?? 'git';
    // The cast: unneeded here, but an app that types NODE_ENV as required (the dashboard) needs it.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    this.env = gitEnvironment(o.sourceEnv ?? process.env) as NodeJS.ProcessEnv;
  }

  /** The overrides for the repo at `cwd` (repoConfigGuard); reading config runs nothing. */
  private async guard(cwd: string): Promise<string[]> {
    const out = await exec(
      this.bin,
      [...SAFE_GIT, '-C', cwd, 'config', '--list', '--show-scope', '-z'],
      undefined,
      { env: this.env },
    ).catch(() => null);
    return repoConfigGuard(out ? parseConfigList(out.stdout) : []);
  }

  private async run(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
    const all = [...SAFE_GIT, ...(await this.guard(cwd)), '-C', cwd, ...args];
    return (await exec(this.bin, all, undefined, { env: this.env, timeoutMs })).stdout;
  }

  private git(cwd: string, args: string[]): Promise<string> {
    return this.run(cwd, args);
  }

  async fetch(repoPath: string, ref: string): Promise<void> {
    await this.run(repoPath, ['fetch', '--quiet', 'origin', '--', ref], FETCH_TIMEOUT_MS);
  }

  async addWorktree(repoPath: string, worktreePath: string, branch: string, baseRef: string): Promise<void> {
    await this.git(repoPath, ['worktree', 'add', '--no-track', '-b', branch, '--', worktreePath, baseRef]);
  }

  async removeWorktree(
    repoPath: string,
    worktreePath: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    await this.git(repoPath, [
      'worktree',
      'remove',
      ...(options.force ? ['--force'] : []),
      '--',
      worktreePath,
    ]);
  }

  async branchExists(repoPath: string, branch: string): Promise<boolean> {
    try {
      await this.git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      return true;
    } catch (err) {
      if (err instanceof ExecError && err.code === 1) return false;
      throw err;
    }
  }

  async deleteBranch(repoPath: string, branch: string): Promise<void> {
    await this.git(repoPath, ['branch', '-D', '--', branch]);
  }

  async currentBranch(path: string): Promise<string> {
    return (await this.git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  }

  async status(path: string): Promise<string> {
    return (await this.git(path, ['status', '--short'])).trimEnd();
  }

  async diffStat(path: string): Promise<string> {
    return (await this.git(path, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--stat'])).trimEnd();
  }

  async recentCommits(path: string, count: number): Promise<string[]> {
    const out = await this.git(path, ['log', '--no-show-signature', `-n${count}`, '--format=%h %s']);
    return out.split('\n').filter((l) => l !== '');
  }

  async commitsAhead(path: string, ref: string): Promise<number> {
    return Number((await this.git(path, ['rev-list', '--count', `${ref}..HEAD`])).trim());
  }

  async isTracked(path: string, relPath: string): Promise<boolean> {
    return (await this.git(path, ['ls-files', '--', relPath])).trim() !== '';
  }

  async push(path: string, branch: string): Promise<void> {
    await this.git(path, ['push', '-u', 'origin', '--', branch]);
  }

  async excludeFile(path: string): Promise<string> {
    const out = (await this.git(path, ['rev-parse', '--git-path', 'info/exclude'])).trim();
    return isAbsolute(out) ? out : resolve(path, out);
  }
}
