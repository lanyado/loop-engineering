import { appendFile, copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { isSafeRelativePath, ValidationError, type EnvFile, type Repo } from '@loop-engineering/core';
import { CommandError, runCommand, type Runner, type RunResult } from '@loop-engineering/runner';
import type { LocalBranchResult, PushResult, RemoteBranchResult, Workspace } from './ports.js';

/**
 * Author of the loop's own commits only when the repo has no git identity. Normally they are the
 * user's: deploy hosts (Vercel) refuse to deploy commits by an author they cannot match to an account.
 */
const LOOP_IDENTITY = ['-c', 'user.name=loop-engineering', '-c', 'user.email=loop-engineering@localhost'];

/**
 * On every git command the loop runs: no hooks and no fsmonitor. A job can write .git/hooks or
 * core.fsmonitor into the repo config it shares, and the loop's own git (with the user's
 * credentials) must never run them.
 */
const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

/** Environment of the loop's git commands: enough to push as the user, none of the server's secrets. */
const GIT_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TZ',
  'XDG_CONFIG_HOME',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GIT_SSH_COMMAND',
] as const;

export function gitEnvironment(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  for (const name of GIT_ENV_ALLOWLIST) {
    const value = source[name];
    if (value) env[name] = value;
  }
  return env;
}

/**
 * Project agent configuration removed from a job checkout before the job runs: a PR could otherwise
 * add plugins, agents, MCP servers or permissions to its own reviewer. Only in the loop's throwaway
 * checkout, never in the builder's worktree; the reviewer still sees these files in the diff.
 */
export const JOB_CONFIG_PATHS = [
  'opencode.json',
  'opencode.jsonc',
  '.opencode',
  '.claude',
  '.mcp.json',
] as const;

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/**
 * Job checkouts as detached git worktrees under `root` (one folder per job, removed after it), so a
 * reviewer or tester never touches the builder's worktree.
 */
export class GitWorkspace implements Workspace {
  private readonly root: string;
  private readonly run: Runner;
  private readonly gitBin: string;
  private readonly env: Record<string, string>;

  constructor(
    root: string,
    options: { run?: Runner; git?: string; sourceEnv?: Record<string, string | undefined> } = {},
  ) {
    if (!isAbsolute(root)) throw new ValidationError('the jobs folder must be an absolute path');
    this.root = resolve(root);
    this.run = options.run ?? runCommand;
    this.gitBin = options.git ?? 'git';
    this.env = gitEnvironment(options.sourceEnv ?? process.env);
  }

  /** Every git command goes through here: hooks and fsmonitor off, a scrubbed environment. */
  private exec(cwd: string, args: string[]): Promise<RunResult> {
    return this.run(this.gitBin, [...SAFE_GIT, '-C', cwd, ...args], { env: this.env, cleanEnv: true });
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const result = await this.exec(cwd, args);
    if (result.code !== 0) throw new CommandError(`git ${args.join(' ')}`, result);
    return result.stdout;
  }

  async checkout(input: {
    repo: Repo;
    branch: string;
    sha: string;
    name: string;
    envFiles: EnvFile[];
  }): Promise<string> {
    const path = join(this.root, input.name);
    if (!resolve(path).startsWith(this.root + sep))
      throw new ValidationError(`job folder ${path} is outside ${this.root}`);
    await this.remove(input.repo, path);
    await mkdir(this.root, { recursive: true });
    await this.git(input.repo.path, [
      'fetch',
      '--quiet',
      'origin',
      `+refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`,
    ]);
    await this.git(input.repo.path, ['worktree', 'add', '--detach', '--force', '--', path, input.sha]);
    for (const config of JOB_CONFIG_PATHS) await rm(join(path, config), { recursive: true, force: true });
    const excludes: string[] = [];
    for (const file of input.envFiles.filter((f) => f.repo === input.repo.name)) {
      if (!isSafeRelativePath(file.target) || !(await exists(file.source))) continue;
      if ((await this.git(path, ['ls-files', '--', file.target])).trim() !== '') continue; // tracked: leave it
      await copyFile(file.source, join(path, file.target));
      excludes.push(`/${file.target}`);
    }
    await this.exclude(path, excludes);
    return path;
  }

  async remove(repo: Repo, path: string): Promise<void> {
    if (!resolve(path).startsWith(this.root + sep)) return;
    if (await exists(path)) {
      await this.git(repo.path, ['worktree', 'remove', '--force', '--', path]).catch(() => undefined);
      await rm(path, { recursive: true, force: true });
    }
    await this.git(repo.path, ['worktree', 'prune']).catch(() => undefined);
  }

  async isAncestor(repo: Repo, sha: string, ref: string): Promise<boolean> {
    return (await this.exec(repo.path, ['merge-base', '--is-ancestor', sha, ref])).code === 0;
  }

  async commitAndPush(
    repo: Repo,
    path: string,
    input: { branch: string; baseSha: string; message: string },
  ): Promise<PushResult> {
    // Only on top of the head the job was given (a job that moved HEAD elsewhere is refused).
    if ((await this.exec(path, ['merge-base', '--is-ancestor', input.baseSha, 'HEAD'])).code !== 0) {
      return { status: 'rejected', reason: `the checkout no longer contains ${input.baseSha}` };
    }
    // The agent config removed before the job stays out of the commit (its deletion included).
    // Also exclude test-result.json which the tester may write as a temporary output file.
    const excluded = [...JOB_CONFIG_PATHS.map((p) => `:(exclude)${p}`), ':(exclude)test-result.json'];
    await this.git(path, ['add', '-A', '--', '.', ...excluded]);
    if ((await this.exec(path, ['diff', '--cached', '--quiet'])).code !== 0) {
      const identity = (await this.hasIdentity(path)) ? [] : LOOP_IDENTITY;
      await this.git(path, [...identity, 'commit', '-q', '--no-verify', '-m', input.message]);
    }
    const head = (await this.git(path, ['rev-parse', 'HEAD'])).trim();
    if (head === input.baseSha) return { status: 'none' };
    // To the remote URL itself (not a remote name the checkout could redefine), and only while the
    // branch is still where the job started: a builder push in the meantime wins.
    const push = await this.exec(path, [
      'push',
      '--no-verify',
      `--force-with-lease=refs/heads/${input.branch}:${input.baseSha}`,
      repo.remote,
      `HEAD:refs/heads/${input.branch}`,
    ]);
    if (push.code !== 0)
      return { status: 'rejected', reason: (push.stderr || push.stdout).trim().slice(0, 500) };
    return { status: 'pushed', sha: head };
  }

  /** Whether git in `path` has a user name and email (repo, global or system config). */
  private async hasIdentity(path: string): Promise<boolean> {
    for (const key of ['user.name', 'user.email']) {
      const r = await this.exec(path, ['config', '--get', key]);
      if (r.code !== 0 || r.stdout.trim() === '') return false;
    }
    return true;
  }

  async deleteRemoteBranch(repo: Repo, branch: string, expectedSha: string): Promise<RemoteBranchResult> {
    const ls = await this.git(repo.path, ['ls-remote', '--heads', repo.remote, `refs/heads/${branch}`]);
    const current = ls.trim().split(/\s+/)[0];
    if (!current) return 'gone';
    if (current !== expectedSha) return 'moved';
    const push = await this.exec(repo.path, [
      'push',
      '--no-verify',
      `--force-with-lease=refs/heads/${branch}:${expectedSha}`,
      repo.remote,
      '--delete',
      `refs/heads/${branch}`,
    ]);
    if (push.code === 0) return 'deleted';
    if (/stale info|rejected/i.test(push.stderr)) return 'moved';
    if (/remote ref does not exist/i.test(push.stderr)) return 'gone';
    throw new Error(`git push --delete ${branch} failed: ${push.stderr.trim().slice(0, 500)}`);
  }

  /**
   * Squash merges leave the branch tip outside the default branch, so `git branch -d` would refuse
   * every time. The check is instead: the tip is an ancestor of the merged PR head (every local
   * commit was merged), no worktree has it checked out, and the delete is a compare-and-delete on
   * that tip (`update-ref -d <ref> <tip>`), so a commit made in between keeps the branch.
   */
  async deleteLocalBranch(repo: Repo, branch: string, mergedHeadSha: string): Promise<LocalBranchResult> {
    const ref = `refs/heads/${branch}`;
    const tip = await this.exec(repo.path, ['rev-parse', '--verify', '--quiet', ref]);
    if (tip.code !== 0) return 'gone';
    const sha = tip.stdout.trim();
    if (!(await this.isAncestor(repo, sha, mergedHeadSha))) return 'kept';
    const worktrees = await this.git(repo.path, ['worktree', 'list', '--porcelain']);
    if (worktrees.split('\n').includes(`branch ${ref}`)) return 'kept';
    await this.git(repo.path, ['update-ref', '-d', ref, sha]);
    return 'deleted';
  }

  /** Keeps copied env files out of `git add -A` (info/exclude is shared by the repo's worktrees). */
  private async exclude(path: string, patterns: string[]): Promise<void> {
    if (patterns.length === 0) return;
    const out = (await this.git(path, ['rev-parse', '--git-path', 'info/exclude'])).trim();
    const file = isAbsolute(out) ? out : resolve(path, out);
    const current = await readFile(file, 'utf8').catch(() => '');
    const have = new Set(current.split('\n'));
    const missing = patterns.filter((p) => !have.has(p));
    if (missing.length === 0) return;
    await mkdir(resolve(file, '..'), { recursive: true });
    const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
    await appendFile(file, `${prefix}# loop-engineering jobs\n${missing.join('\n')}\n`);
  }
}
