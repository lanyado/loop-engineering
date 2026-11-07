import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecError } from './exec.js';
import {
  isGitLockError,
  REPO_LOCK_NAME,
  RepoLockTimeoutError,
  retryGitLock,
  withRepoLock,
} from './repo-lock.js';

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const FAST = { pollMs: 5 };

describe('withRepoLock', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'repo-lock-'));
  });
  afterEach(() => {
    execFileSync('chmod', ['-R', 'u+rwx', dir]);
    rmSync(dir, { recursive: true, force: true });
  });

  /** A repo folder with a .git of its own (mode 755 whatever the umask). */
  const repoAt = (name: string) => {
    const repo = join(dir, name);
    mkdirSync(join(repo, '.git'), { recursive: true });
    chmodSync(join(repo, '.git'), 0o755);
    return repo;
  };
  const lockOf = (repo: string) => join(repo, '.git', REPO_LOCK_NAME);
  /** A lock folder as another process would leave it. */
  const plant = (repo: string, owner: string | null, ageMs = 0) => {
    mkdirSync(lockOf(repo));
    if (owner !== null) writeFileSync(join(lockOf(repo), 'owner'), owner);
    const then = new Date(Date.now() - ageMs);
    if (owner !== null) utimesSync(join(lockOf(repo), 'owner'), then, then);
    utimesSync(lockOf(repo), then, then);
  };

  /** Runs holders of the lock at once and returns the most that were ever inside together. */
  async function overlap(paths: string[]): Promise<number> {
    let inside = 0;
    let most = 0;
    await Promise.all(
      paths.map((path) =>
        withRepoLock(
          path,
          async () => {
            most = Math.max(most, ++inside);
            await sleep(20);
            inside--;
          },
          FAST,
        ),
      ),
    );
    return most;
  }

  it("runs one holder at a time per repo, in order, with its lock folder in the repo's .git", async () => {
    const repo = repoAt('repo');
    expect(await overlap([repo, repo, `${repo}/`, join(repo, '.')])).toBe(1);
    expect(await overlap([repo, repoAt('other')])).toBe(2);

    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => withRepoLock(repo, () => Promise.resolve(order.push(n)), FAST)));
    expect(order).toEqual([1, 2, 3]);

    // Held: a folder of this user's only, whose owner file names this process.
    await withRepoLock(repo, () => {
      expect(statSync(lockOf(repo)).mode & 0o077).toBe(0);
      expect(readFileSync(join(lockOf(repo), 'owner'), 'utf8').split(' ')[0]).toBe(String(process.pid));
      return Promise.resolve();
    });
    // Released, also after a holder that threw.
    await expect(withRepoLock(repo, () => Promise.reject(new Error('git failed')))).rejects.toThrow(
      'git failed',
    );
    expect(existsSync(lockOf(repo))).toBe(false);
  });

  it('refreshes its owner file while held, so a long git command is never taken for a hung one', async () => {
    const repo = repoAt('repo');
    await withRepoLock(
      repo,
      async () => {
        const owner = join(lockOf(repo), 'owner');
        const then = new Date(Date.now() - 60_000);
        utimesSync(owner, then, then);
        await sleep(120);
        expect(Date.now() - statSync(owner).mtimeMs).toBeLessThan(1000);
      },
      { heartbeatMs: 20 },
    );
  });

  it("waits for another process's lock, and takes over one whose holder is gone, silent or never wrote", async () => {
    const repo = repoAt('repo');
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      // Held by a live process (a second server, a CLI): wait until it is released.
      plant(repo, `${child.pid} other x`);
      let entered = false;
      const waiting = withRepoLock(repo, () => Promise.resolve((entered = true)), FAST);
      await sleep(100);
      expect(entered).toBe(false);
      rmSync(lockOf(repo), { recursive: true, force: true });
      await waiting;
      expect(entered).toBe(true);

      // A live pid whose owner file stopped being refreshed (a hung holder, or a reused pid).
      plant(repo, `${child.pid} other x`, 10 * 60_000);
      await withRepoLock(repo, () => Promise.resolve(), FAST);
      // A folder whose maker died before writing its owner file: after a short grace only.
      plant(repo, null, 60_000);
      await withRepoLock(repo, () => Promise.resolve(), FAST);
    } finally {
      child.kill('SIGKILL');
    }
    await new Promise((done) => child.once('exit', done));
    // Its holder died without releasing it: taken over at once.
    plant(repo, `${child.pid} gone x`);
    await withRepoLock(repo, () => Promise.resolve(), FAST);
    expect(readdirSync(join(repo, '.git'))).toEqual([]); // nothing left aside either
  });

  /** Runs `fn` under the lock, failing the test (instead of hanging it) if it takes over 2 s. */
  async function within2s(repo: string, options: Parameters<typeof withRepoLock>[2] = {}) {
    const warnings: string[] = [];
    let ran = false;
    const started = Date.now();
    const result = await Promise.race([
      withRepoLock(repo, () => Promise.resolve((ran = true)), {
        ...FAST,
        ...options,
        log: (m) => warnings.push(m),
      }),
      sleep(2000).then(() => 'hung'),
    ]);
    expect(result).toBe(true);
    return { ran, warnings, ms: Date.now() - started };
  }

  it('runs with the in-process lock only, with a warning, after waitMs on a lock that is never released', async () => {
    const repo = repoAt('repo');
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      plant(repo, `${child.pid} other x`);
      const beat = setInterval(() => {
        const now = new Date();
        utimesSync(join(lockOf(repo), 'owner'), now, now);
      }, 20);
      try {
        const { ran, warnings, ms } = await within2s(repo, { waitMs: 200 });
        expect(ran).toBe(true);
        expect(ms).toBeGreaterThanOrEqual(190);
        expect(warnings).toEqual([expect.stringContaining('another process held')]);
      } finally {
        clearInterval(beat);
      }
      // Never touched: it is the other process's.
      expect(readFileSync(join(lockOf(repo), 'owner'), 'utf8')).toBe(`${child.pid} other x`);
      // A fresh folder with no owner file yet is someone else's, being made: waited for too.
      rmSync(lockOf(repo), { recursive: true, force: true });
      plant(repo, null);
      const ownerless = await within2s(repo, { waitMs: 100 });
      expect(ownerless.ms).toBeGreaterThanOrEqual(90);
      expect(existsSync(lockOf(repo))).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('never spins on a link or a file at the lock path: runs at once with a warning, leaving it alone', async () => {
    const repo = repoAt('repo');
    const target = join(dir, 'target');
    mkdirSync(target);
    for (const [what, make] of [
      ['a dangling link', () => symlinkSync(join(dir, 'nowhere'), lockOf(repo))],
      ['a link to a folder', () => symlinkSync(target, lockOf(repo))],
      ['a file', () => writeFileSync(lockOf(repo), '')],
    ] as const) {
      make();
      const { ran, warnings, ms } = await within2s(repo);
      expect(ran, what).toBe(true);
      expect(ms, what).toBeLessThan(500);
      expect(warnings, what).toEqual([expect.stringContaining('is not a lock folder')]);
      expect(lstatSync(lockOf(repo)).isDirectory(), what).toBe(false);
      rmSync(lockOf(repo), { force: true });
    }
    expect(readdirSync(target)).toEqual([]); // nothing written through the link
  });

  it('takes over a stale lock it cannot remove (moved aside), and gives up on one it cannot move', async () => {
    const repo = repoAt('repo');
    // Its holder is gone, and it holds a folder nobody can empty.
    plant(repo, '999999999 gone x');
    mkdirSync(join(lockOf(repo), 'sub'));
    writeFileSync(join(lockOf(repo), 'sub', 'f'), '');
    chmodSync(join(lockOf(repo), 'sub'), 0o555);
    const removable = () => {
      for (const name of readdirSync(join(repo, '.git')))
        if (existsSync(join(repo, '.git', name, 'sub'))) chmodSync(join(repo, '.git', name, 'sub'), 0o755);
    };
    try {
      const first = await within2s(repo);
      expect(first.ran).toBe(true);
      expect(first.warnings).toEqual([expect.stringContaining('left the stale lock')]);
      expect(existsSync(lockOf(repo))).toBe(false); // the lock's path is free again
    } finally {
      removable();
    }
    if (process.getuid?.() === 0) return; // root moves anything
    // A stale lock in a .git it may not change: three tries, then the in-process lock only.
    plant(repo, '999999999 gone x');
    chmodSync(join(repo, '.git'), 0o555);
    try {
      const second = await within2s(repo);
      expect(second.ran).toBe(true);
      expect(second.ms).toBeLessThan(1000);
      expect(second.warnings).toEqual([expect.stringContaining('could not move the stale lock')]);
    } finally {
      chmodSync(join(repo, '.git'), 0o755);
    }
  });

  it('a caller that gives up in the queue keeps the order of the others', async () => {
    const repo = repoAt('repo');
    const events: string[] = [];
    const first = withRepoLock(repo, async () => {
      events.push('first in');
      await sleep(150);
      events.push('first out');
    });
    const impatient = withRepoLock(repo, () => Promise.resolve(events.push('impatient in')), {
      waitMs: 30,
    });
    const third = withRepoLock(repo, () => Promise.resolve(events.push('third in')));
    await expect(impatient).rejects.toBeInstanceOf(RepoLockTimeoutError);
    await Promise.all([first, third]);
    expect(events).toEqual(['first in', 'first out', 'third in']);
  });

  it('uses only the in-process lock when .git is a link or others can write it', async () => {
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    chmodSync(elsewhere, 0o777);
    const linked = join(dir, 'linked');
    mkdirSync(linked);
    symlinkSync(elsewhere, join(linked, '.git'));
    const open = repoAt('open');
    chmodSync(join(open, '.git'), 0o777);
    for (const repo of [linked, open]) {
      expect(await overlap([repo, repo, repo])).toBe(1);
      await withRepoLock(repo, () => {
        expect(existsSync(lockOf(repo))).toBe(false);
        return Promise.resolve();
      });
    }
    expect(readdirSync(elsewhere)).toEqual([]);
    // No .git at all (a folder that isn't a repo's top): the in-process lock still runs it.
    expect(await withRepoLock(join(dir, 'missing'), () => Promise.resolve(7))).toBe(7);
  });
});

describe('retryGitLock', () => {
  const locked = new ExecError(
    'git fetch',
    1,
    "error: cannot lock ref 'refs/remotes/origin/main': Unable to create '/r/.git/refs/remotes/origin/main.lock': File exists.",
  );
  const moved = new ExecError(
    'git update-ref',
    128,
    "fatal: cannot lock ref 'refs/heads/x': is at 1a2b but expected 3c4d",
  );

  it('retries git only when it found the repo locked', async () => {
    let calls = 0;
    const delaysMs = [1, 1, 1];
    expect(
      await retryGitLock(() => (++calls < 3 ? Promise.reject(locked) : Promise.resolve('ok')), { delaysMs }),
    ).toBe('ok');
    expect(calls).toBe(3);

    calls = 0;
    await expect(retryGitLock(() => (calls++, Promise.reject(locked)), { delaysMs: [1, 1] })).rejects.toBe(
      locked,
    );
    expect(calls).toBe(3);

    calls = 0;
    const denied = new ExecError('git fetch', 128, 'git@github.com: Permission denied (publickey).');
    await expect(retryGitLock(() => (calls++, Promise.reject(denied)), { delaysMs })).rejects.toBe(denied);
    expect(calls).toBe(1);
  });

  it('retries a ref that moved under it only for a fetch, never a compare-and-delete', async () => {
    let calls = 0;
    await expect(retryGitLock(() => (calls++, Promise.reject(moved)), { delaysMs: [1, 1] })).rejects.toBe(
      moved,
    );
    expect(calls).toBe(1);
    calls = 0;
    await expect(
      retryGitLock(() => (calls++, Promise.reject(moved)), { delaysMs: [1, 1], refRace: true }),
    ).rejects.toBe(moved);
    expect(calls).toBe(3);
  });

  it("recognises git's lock messages", () => {
    expect(isGitLockError(locked.stderr)).toBe(true);
    expect(
      isGitLockError(
        "fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running",
      ),
    ).toBe(true);
    expect(isGitLockError(moved.stderr)).toBe(false);
    expect(isGitLockError('fatal: not a git repository')).toBe(false);
  });
});
