import { isAbsolute, resolve } from 'node:path';
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
  /** True when `relPath` (a file, or any file under a folder) is tracked in the checkout at `path`. */
  isTracked(path: string, relPath: string): Promise<boolean>;
  push(path: string, branch: string): Promise<void>;
  /** Absolute path of the info/exclude file that applies to `path` (shared by all worktrees of a repo). */
  excludeFile(path: string): Promise<string>;
}

export class RealGitDriver implements GitDriver {
  constructor(private readonly bin = 'git') {}

  private async git(cwd: string, args: string[]): Promise<string> {
    return (await exec(this.bin, ['-C', cwd, ...args])).stdout;
  }

  async fetch(repoPath: string, ref: string): Promise<void> {
    await exec(this.bin, ['-C', repoPath, 'fetch', '--quiet', 'origin', '--', ref], undefined, {
      timeoutMs: FETCH_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
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
    return (await this.git(path, ['diff', 'HEAD', '--stat'])).trimEnd();
  }

  async recentCommits(path: string, count: number): Promise<string[]> {
    const out = await this.git(path, ['log', `-n${count}`, '--format=%h %s']);
    return out.split('\n').filter((l) => l !== '');
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
