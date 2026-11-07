import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, rmdir, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ExecError } from './exec.js';

/**
 * What git prints when another git holds a lock file in the repo: a ref (`cannot lock ref …:
 * Unable to create '….lock': File exists`, a fetch racing another fetch), the index or
 * `packed-refs`.
 */
const GIT_LOCK_ERROR = /unable to create '[^']*\.lock'|another git process seems to be running/i;
/**
 * A ref that moved while git updated it. For a fetch that is another fetch writing the same ref at
 * once; for a compare-and-delete (`update-ref -d <ref> <old>`) it is the answer, not a race.
 */
const GIT_REF_MOVED = /cannot lock ref '[^']*': is at [0-9a-f]+ but expected [0-9a-f]+/i;

export function isGitLockError(text: string): boolean {
  return GIT_LOCK_ERROR.test(text);
}

/** Waits before each retry of a git command that found the repo locked. */
export const GIT_LOCK_RETRY_MS = [500, 1500, 4000] as const;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Runs `run` again when git failed only because another git held a lock in the repo (a builder's
 * own fetch, say, which no lock of ours covers). `refRace`: also when a ref moved under it (only
 * for a fetch). Any other failure is thrown at once.
 */
export async function retryGitLock<T>(
  run: () => Promise<T>,
  options: { delaysMs?: readonly number[]; refRace?: boolean } = {},
): Promise<T> {
  const delays = options.delaysMs ?? GIT_LOCK_RETRY_MS;
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (err) {
      const text = err instanceof ExecError ? `${err.stderr}\n${err.stdout}` : '';
      const locked = isGitLockError(text) || (options.refRace === true && GIT_REF_MOVED.test(text));
      if (!locked || i >= delays.length) throw err;
      await sleep(delays[i]!);
    }
  }
}

/** No lock in time: the command did not run. */
export class RepoLockTimeoutError extends Error {
  override name = 'RepoLockTimeoutError';
}

export interface RepoLockOptions {
  /**
   * Longest wait for the lock, from the call. Waiting behind this process's own git commands (they
   * have time limits of their own, so this is a backlog): then RepoLockTimeoutError, and `fn` does
   * not run. Waiting for another process's lock: then a warning, and `fn` runs with the in-process
   * lock only, as before there was a cross-process lock (git's own locks and retryGitLock remain).
   * Default 20 minutes, longer than the longest git command (GIT_LONG_TIMEOUT_MS, 10 minutes).
   */
  waitMs?: number;
  /** A held lock refreshes its owner file this often. */
  heartbeatMs?: number;
  /** A lock whose owner file is older than this is taken over: its holder hung or is gone. */
  staleMs?: number;
  /** A lock folder with no owner file is taken over once it is this old (its maker died in between). */
  ownerlessMs?: number;
  /** How often a waiter for another process's lock looks again. */
  pollMs?: number;
  /** Where warnings go (a lock given up on, a stale lock left behind). Default console.warn. */
  log?: (message: string) => void;
}

const WAIT_MS = 20 * 60_000;
const HEARTBEAT_MS = 20_000;
const STALE_MS = 2 * 60_000;
const OWNERLESS_MS = 5_000;
const POLL_MS = 100;
/** Stale locks this caller failed to move aside before it gives up on the file lock. */
const MAX_TAKEOVER_FAILURES = 3;
/** The lock folder, in the repo's own .git: owned by the user Loop runs as, never in a shared /tmp. */
export const REPO_LOCK_NAME = 'loop-engineering-lock';

/** This copy of the module: a lock with our pid but another copy's id is not ours to take. */
const INSTANCE = randomUUID();

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
 * (callers queue in order), then across processes (a lock folder in the repo's .git, so two
 * servers, or a server and a CLI, take turns too). For git commands that write the repo shared by
 * its worktrees: fetches into `refs/remotes`, `worktree add|remove|prune`, branch deletes. Two of
 * those at once fail on git's own locks (`cannot lock ref`). Not reentrant: `fn` must not take the
 * same lock. No lock within `waitMs`: RepoLockTimeoutError, and `fn` does not run.
 */
export async function withRepoLock<T>(
  repoPath: string,
  fn: () => Promise<T>,
  options: RepoLockOptions = {},
): Promise<T> {
  const key = repoKey(repoPath);
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  // The next caller waits for `previous` too, so one that gives up early keeps the order.
  const tail = Promise.all([previous, done]).then(() => undefined);
  queues.set(key, tail);
  let timer: NodeJS.Timeout | undefined;
  try {
    const turn = await Promise.race([
      previous.then(() => true),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), deadline - Date.now()))),
    ]);
    if (!turn) throw new RepoLockTimeoutError(`waited too long for the git lock of ${key}`);
    const unlock = await fileLock(key, deadline, options);
    try {
      return await fn();
    } finally {
      await unlock();
    }
  } finally {
    clearTimeout(timer);
    release();
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
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

const code = (err: unknown) => (err as NodeJS.ErrnoException).code;

/**
 * The repo's .git when a lock folder can safely live there: a real folder (not a link), owned by
 * this user, that not everyone can write. Group write is the repo's own choice: whoever can write
 * its .git can rewrite the repo anyway. Otherwise null, and only the in-process lock applies.
 */
async function lockParent(key: string): Promise<string | null> {
  const dir = join(key, '.git');
  try {
    const s = await lstat(dir);
    const uid = typeof process.getuid === 'function' ? process.getuid() : s.uid;
    return s.isDirectory() && s.uid === uid && (s.mode & 0o002) === 0 ? dir : null;
  } catch {
    return null;
  }
}

/**
 * A folder per repo in its .git, made with mkdir (atomic), whose owner file (written exclusively,
 * so never through a link) holds the owner's pid and is refreshed while it is held. Taken over when
 * that process is gone, the owner file has not been refreshed for staleMs, or a folder has had no
 * owner file for ownerlessMs. Every look at it uses lstat, and every retry waits pollMs first.
 * A lock that cannot be used never stops git, and never spins: no usable .git, something other
 * than a folder at the lock's path (a link, a file), stale locks that cannot be moved aside, or
 * another process's lock past the deadline. Then a warning (except for no usable .git), and the
 * command runs with the in-process lock only, as scripts/heavy runs without a slot.
 */
async function fileLock(key: string, deadline: number, o: RepoLockOptions): Promise<() => Promise<void>> {
  const none = () => Promise.resolve();
  const log = o.log ?? ((m: string) => console.warn(`[git-lock] ${m}`));
  const giveUp = (why: string) => {
    log(`${key}: ${why}; running with the in-process lock only`);
    return none;
  };
  const parent = await lockParent(key);
  if (!parent) return none;
  const lock = join(parent, REPO_LOCK_NAME);
  const owner = join(lock, 'owner');
  const token = `${process.pid} ${INSTANCE} ${randomUUID()}`;
  let failedTakeovers = 0;
  for (;;) {
    let made = false;
    try {
      await mkdir(lock, { mode: 0o700 });
      made = true;
      await writeFile(owner, token, { flag: 'wx', mode: 0o600 });
      const beat = setInterval(() => {
        const now = new Date();
        void utimes(owner, now, now).catch(() => undefined);
      }, o.heartbeatMs ?? HEARTBEAT_MS);
      beat.unref();
      return async () => {
        clearInterval(beat);
        if ((await readOwner(owner)) !== token) return;
        await rm(lock, { recursive: true, force: true }).catch((err: unknown) =>
          log(`${key}: could not remove its lock ${lock}: ${String(err)}`),
        );
      };
    } catch (err) {
      if (made) {
        // EEXIST: another owner file got there first (a takeover put a live lock back): wait.
        if (code(err) !== 'EEXIST') {
          await rmdir(lock).catch(() => undefined); // only if still empty: never someone else's
          return giveUp(`could not write ${owner} (${code(err) ?? String(err)})`);
        }
      } else if (code(err) !== 'EEXIST') {
        return giveUp(`could not make ${lock} (${code(err) ?? String(err)})`);
      }
    }
    const entry = await lstat(lock).catch(() => null);
    if (entry && !entry.isDirectory()) return giveUp(`${lock} is not a lock folder (a link or a file)`);
    if (entry) {
      const stale = await staleToken(lock, owner, o);
      if (stale !== null && !(await takeOver(lock, owner, stale, (m) => log(`${key}: ${m}`)))) {
        if (++failedTakeovers >= MAX_TAKEOVER_FAILURES)
          return giveUp(`could not move the stale lock ${lock} aside`);
      }
    }
    if (Date.now() >= deadline) return giveUp(`another process held ${lock} for too long`);
    await sleep(Math.max(1, Math.min(o.pollMs ?? POLL_MS, deadline - Date.now())));
  }
}

/** The owner file's content, or '' when it is missing, unreadable, or not a plain file. */
async function readOwner(owner: string): Promise<string> {
  const entry = await lstat(owner).catch(() => null);
  if (!entry?.isFile()) return '';
  return readFile(owner, 'utf8').catch(() => '');
}

/** The owner file's content when the lock may be taken over ('' for no usable owner file), else null. */
async function staleToken(lock: string, owner: string, o: RepoLockOptions): Promise<string | null> {
  const ownerStat = await lstat(owner).catch(() => null);
  if (!ownerStat?.isFile()) {
    const folder = await lstat(lock).catch(() => null);
    if (!folder) return null; // released meanwhile: try again (after pollMs)
    return Date.now() - folder.mtimeMs > (o.ownerlessMs ?? OWNERLESS_MS) ? '' : null;
  }
  const text = await readOwner(owner);
  const [pidText, instance] = text.split(' ');
  const pid = Number(pidText);
  // This copy of the module holds no lock on the repo (the queue above): one with its id was left behind.
  const mine = pid === process.pid && instance === INSTANCE;
  const gone = Number.isInteger(pid) && pid > 0 && pid !== process.pid && !isAlive(pid);
  const silent = Date.now() - ownerStat.mtimeMs > (o.staleMs ?? STALE_MS);
  return mine || gone || silent ? text : null;
}

/**
 * Moves a stale lock aside under a name of its own, then removes it: never rm-then-mkdir, which
 * could remove a lock another waiter has just taken. The token is checked right before the move,
 * and the moved folder's token after it: a fresh lock moved by mistake is put back. False only
 * when the lock could not be moved: the caller counts those and gives up. A moved lock that cannot
 * be removed is left aside (logged): the lock's path is free either way.
 */
async function takeOver(
  lock: string,
  owner: string,
  stale: string,
  log: (message: string) => void,
): Promise<boolean> {
  if ((await readOwner(owner)) !== stale) return true; // changed meanwhile: look again
  const aside = `${lock}.stale-${randomUUID()}`;
  try {
    await rename(lock, aside);
  } catch (err) {
    return code(err) === 'ENOENT'; // someone else moved it
  }
  if ((await readOwner(join(aside, 'owner'))) !== stale) {
    await rename(aside, lock).catch(() => undefined);
    return true;
  }
  await rm(aside, { recursive: true, force: true }).catch((err: unknown) =>
    log(`left the stale lock ${aside}, which cannot be removed: ${String(err)}`),
  );
  return true;
}
