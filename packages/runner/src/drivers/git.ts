import { isAbsolute, resolve } from 'node:path';
import { gitEnvironment } from '../agent-env.js';
import { exec, ExecError, type ExecResult } from './exec.js';

/** An unreachable remote must not stall a session start. */
const FETCH_TIMEOUT_MS = 30_000;
/**
 * Every other git command has a limit too: a repo's config can make git wait forever (an include.path
 * naming a FIFO), and the runner must not hang with it. A timeout stops git and everything it started.
 */
export const GIT_TIMEOUT_MS = 120_000;
/** A push, or a fetch or checkout that may move a whole repo. */
export const GIT_LONG_TIMEOUT_MS = 600_000;
const CONFIG_TIMEOUT_MS = 30_000;

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
 * that makes git run a command, and that a later value overrides: emptied (a filter or diff driver
 * with no command is skipped), or set back to the user's own (system and global) value. Config git
 * reads first-wins (remote.*.uploadpack/receivepack, url.*.insteadOf) cannot be overridden; whatever
 * it runs gets only the git environment, no server secret (see docs/reference.md).
 */
const OVERRIDDEN =
  /^(filter\..+\.(clean|smudge|process)|diff\.external|diff\..+\.(textconv|command)|merge\..+\.driver|gpg\.(.+\.)?program|core\.(sshcommand|alternaterefscommand|pager|editor)|pager\..+|sequence\.editor)$/i;
/** Credential helpers, general or for a URL: a list, which an empty value resets. */
const CREDENTIAL_HELPER = /^credential\.(.+\.)?helper$/i;
/** Filters made empty must not be required, or git refuses the file. */
const FILTER_DRIVER = /^filter\.(.+)\.(clean|smudge|process)$/i;
/** What an emptied key falls back to when the user's own config has no value for it. */
const NEUTRAL: Record<string, string> = {
  'core.sshcommand': 'ssh',
  'core.pager': 'cat',
  // Run with the alternate's path; printing nothing just advertises no alternate refs.
  'core.alternaterefscommand': 'true',
};

export interface ConfigEntry {
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

/**
 * The config, in order, that neutralizes the repo's own command-running config. Pure; exported for
 * tests. Given to git as GIT_CONFIG_COUNT/KEY/VALUE (gitConfigEnv), which takes any key, a driver
 * name with "=" in it too, and is read after every config file.
 */
export function repoConfigGuard(entries: ConfigEntry[]): [string, string][] {
  const repo = entries.filter((e) => e.scope === 'local' || e.scope === 'worktree');
  const user = entries.filter((e) => e.scope === 'system' || e.scope === 'global');
  const out: [string, string][] = [];
  // Credential helpers: an empty credential.helper clears the list for every URL, the repo's helpers
  // (read before) included; then every helper of the user's own, general or for a URL, in order.
  if (repo.some((e) => CREDENTIAL_HELPER.test(e.key))) {
    out.push(['credential.helper', '']);
    for (const e of user) if (CREDENTIAL_HELPER.test(e.key)) out.push([e.key, e.value]);
  }
  const seen = new Set<string>();
  for (const { key } of repo) {
    if (seen.has(key) || !OVERRIDDEN.test(key)) continue;
    seen.add(key);
    out.push([key, '']);
    const own = user.filter((e) => e.key === key).map((e) => e.value);
    const neutral = NEUTRAL[key.toLowerCase()];
    if (own.length === 0 && neutral !== undefined) own.push(neutral);
    for (const value of own) out.push([key, value]);
    const filter = FILTER_DRIVER.exec(key)?.[1];
    if (filter !== undefined && !seen.has(`filter.${filter}.required`)) {
      seen.add(`filter.${filter}.required`);
      out.push([`filter.${filter}.required`, 'false']);
    }
  }
  return out;
}

/** `pairs` as git's GIT_CONFIG_COUNT / GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> variables. */
export function gitConfigEnv(pairs: [string, string][]): Record<string, string> {
  if (pairs.length === 0) return {};
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** Thrown when a repo's config cannot be read: then no git command runs there (fails closed). */
export class GitConfigError extends ExecError {
  override name = 'GitConfigError';
}

export interface SafeGitOptions {
  /** Default "git". */
  bin?: string;
  /** Exactly the environment git gets (gitEnvironment), nothing from process.env. */
  env: Record<string, string>;
  /** Limit for the command itself. Default 2 min. */
  timeoutMs?: number;
  /** Limit for reading the repo's config first. Default 30 s. */
  configTimeoutMs?: number;
}

/**
 * The guard for the repo at `cwd` (repoConfigGuard), as environment variables. Reading config runs
 * nothing. Fails closed: when the config cannot be read, GitConfigError, and no git command runs.
 */
async function guardEnv(bin: string, cwd: string, options: SafeGitOptions): Promise<Record<string, string>> {
  let out: string;
  try {
    out = (
      await exec(bin, [...SAFE_GIT, '-C', cwd, 'config', '--list', '--show-scope', '-z'], undefined, {
        env: options.env,
        timeoutMs: options.configTimeoutMs ?? CONFIG_TIMEOUT_MS,
      })
    ).stdout;
  } catch (err) {
    const why = err instanceof ExecError ? err.stderr.trim() || String(err.code) : String(err);
    throw new GitConfigError(
      `${bin} config --list`,
      err instanceof ExecError ? err.code : null,
      `cannot read the git config in ${cwd}, so Loop runs no git there (${why})`,
    );
  }
  return gitConfigEnv(repoConfigGuard(parseConfigList(out)));
}

/**
 * Runs git in `cwd`, in a repo an agent can write (its config, its hooks): with SAFE_GIT, the repo's
 * command-running config neutralized (repoConfigGuard, read first; nothing runs if it cannot be),
 * exactly `options.env`, and a time limit that stops git and whatever it started. The runner's git
 * (RealGitDriver) and the PR loop's job checkouts (GitWorkspace) both run git through this.
 * Rejects with ExecError (GitConfigError when the config could not be read).
 */
export async function safeGit(cwd: string, args: string[], options: SafeGitOptions): Promise<ExecResult> {
  const bin = options.bin ?? 'git';
  const env = { ...options.env, ...(await guardEnv(bin, cwd, options)) };
  return exec(bin, [...SAFE_GIT, '-C', cwd, ...args], undefined, {
    env,
    timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
  });
}

export interface RealGitOptions {
  bin?: string;
  /** Where the git environment (gitEnvironment) is read from. Default process.env. */
  sourceEnv?: Record<string, string | undefined>;
  /** Limit for reading a repo's config before each command, in ms. Default 30 s. */
  configTimeoutMs?: number;
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
  private readonly env: Record<string, string>;
  private readonly configTimeoutMs: number;

  constructor(options: RealGitOptions | string = {}) {
    const o = typeof options === 'string' ? { bin: options } : options;
    this.bin = o.bin ?? 'git';
    this.configTimeoutMs = o.configTimeoutMs ?? CONFIG_TIMEOUT_MS;
    this.env = gitEnvironment(o.sourceEnv ?? process.env);
  }

  private async run(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
    return (
      await safeGit(cwd, args, {
        bin: this.bin,
        env: this.env,
        timeoutMs,
        configTimeoutMs: this.configTimeoutMs,
      })
    ).stdout;
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
    await this.run(path, ['push', '-u', 'origin', '--', branch], GIT_LONG_TIMEOUT_MS);
  }

  async excludeFile(path: string): Promise<string> {
    const out = (await this.git(path, ['rev-parse', '--git-path', 'info/exclude'])).trim();
    return isAbsolute(out) ? out : resolve(path, out);
  }
}
