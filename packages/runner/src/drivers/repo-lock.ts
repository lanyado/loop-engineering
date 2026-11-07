import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ExecError } from './exec.js';

/**
 * What git prints when another git holds a lock in the repo: a ref (`cannot lock ref`, a fetch
 * racing another fetch), the index or `packed-refs` (`Unable to create '….lock': File exists`), or
 * a ref that moved under it.
 */
const GIT_LOCK_ERROR =
  /cannot lock ref|unable to create '[^']*\.lock'|another git process seems to be running|unable to update local ref|is at [0-9a-f]+ but expected/i;

export function isGitLockError(text: string): boolean {
  return GIT_LOCK_ERROR.test(text);
}

/** Waits before each retry of a git command that found the repo locked. */
export const GIT_LOCK_RETRY_MS = [500, 1500, 4000] as const;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Runs `run` again when git failed only because another git held a lock in the repo (a builder's
 * own fetch, say, which no lock of ours covers). Any other failure is thrown at once.
 */
export async function retryGitLock<T>(
  run: () => Promise<T>,
  delaysMs: readonly number[] = GIT_LOCK_RETRY_MS,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (err) {
      const locked = err instanceof ExecError && isGitLockError(`${err.stderr}\n${err.stdout}`);
      if (!locked || i >= delaysMs.length) throw err;
      await sleep(delaysMs[i]!);
    }
  }
}

export interface RepoLockOptions {
  /** Folder of the cross-process lock folders. Default `<os tmpdir>/loop-engineering-git-<uid>`. */
  dir?: string;
  /**
   * A lock held longer than this is taken over: its holder hung or died with it. Longer than the
   * longest git command (GIT_LONG_TIMEOUT_MS, 10 minutes, plus reading the config).
   */
  staleMs?: number;
  /** How often a waiter for another process's lock looks again. */
  pollMs?: number;
}

const STALE_MS = 15 * 60_000;
const POLL_MS = 100;

/** The tail of each repo's queue in this process. */
const queues = new Map<string, Promise<void>>();

function repoKey(repoPath: string): string {
  const path = resolve(repoPath);
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Runs `fn` while no other caller holds the lock of the repo at `repoPath`: first in this process
 * (callers queue in order), then across processes (a lock folder, so two servers, or a server and a
 * CLI, take turns too). For git commands that write the repo shared by its worktrees: fetches into
 * `refs/remotes`, `worktree add|remove|prune`, branch deletes. Two of those at once fail on git's
 * own locks (`cannot lock ref`). Not reentrant: `fn` must not take the same lock.
 */
export async function withRepoLock<T>(
  repoPath: string,
  fn: () => Promise<T>,
  options: RepoLockOptions = {},
): Promise<T> {
  const key = repoKey(repoPath);
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = previous.then(() => new Promise<void>((done) => (release = done)));
  queues.set(key, tail);
  await previous;
  try {
    const unlock = await fileLock(key, options);
    try {
      return await fn();
    } finally {
      await unlock();
    }
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * A folder per repo, made with mkdir (atomic), holding its owner's pid. Taken over when that
 * process is gone or the lock is older than staleMs. A lock folder that cannot be used never stops
 * git: the command runs with the in-process lock only, as scripts/heavy runs without a slot.
 */
async function fileLock(key: string, options: RepoLockOptions): Promise<() => Promise<void>> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const dir = options.dir ?? join(tmpdir(), `loop-engineering-git-${uid}`);
  const lock = join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.lock`);
  const owner = join(lock, 'owner');
  const token = `${process.pid} ${randomUUID()}`;
  const staleMs = options.staleMs ?? STALE_MS;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    return () => Promise.resolve();
  }
  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(owner, token);
      return async () => {
        const holder = await readFile(owner, 'utf8').catch(() => '');
        if (holder === token) await rm(lock, { recursive: true, force: true }).catch(() => undefined);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return () => Promise.resolve();
    }
    const since = await stat(lock).then(
      (s) => s.mtimeMs,
      () => null,
    );
    if (since === null) continue; // released meanwhile
    const pid = Number((await readFile(owner, 'utf8').catch(() => '')).split(' ')[0]);
    // This process holds no lock on the repo (the queue above), so one with its pid was left behind.
    const gone = Number.isInteger(pid) && pid > 0 && (pid === process.pid || !isAlive(pid));
    if (gone || Date.now() - since > staleMs) {
      await rm(lock, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    await sleep(options.pollMs ?? POLL_MS);
  }
}
