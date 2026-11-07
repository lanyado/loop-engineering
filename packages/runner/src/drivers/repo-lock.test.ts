import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecError } from './exec.js';
import { isGitLockError, retryGitLock, withRepoLock } from './repo-lock.js';

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

describe('withRepoLock', () => {
  let dir: string;
  let locks: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'repo-lock-'));
    locks = join(dir, 'locks');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Runs `n` holders of the lock at once and returns the most that were ever inside together. */
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
          { dir: locks, pollMs: 5 },
        ),
      ),
    );
    return most;
  }

  it('runs one holder at a time per repo, in order, and repos independently', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    expect(await overlap([repo, repo, `${repo}/`, join(repo, '.')])).toBe(1);
    const other = join(dir, 'other');
    mkdirSync(other);
    expect(await overlap([repo, other])).toBe(2);

    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        withRepoLock(repo, () => Promise.resolve(order.push(n)), { dir: locks, pollMs: 5 }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
    // Released: nothing left in the lock folder, also after a holder that threw.
    await expect(
      withRepoLock(repo, () => Promise.reject(new Error('git failed')), { dir: locks }),
    ).rejects.toThrow('git failed');
    expect(readdirSync(locks)).toEqual([]);
  });

  it("waits for another process's lock, and takes over one whose process is gone", async () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    // The lock folder the repo uses, seen while holding it.
    const name = await withRepoLock(repo, () => Promise.resolve(readdirSync(locks)[0]!), { dir: locks });
    expect(name).toMatch(/\.lock$/);
    expect(readdirSync(locks)).toEqual([]);
    // Another process (a second server, a CLI) holds it.
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    mkdirSync(join(locks, name));
    writeFileSync(join(locks, name, 'owner'), `${child.pid} other`);
    try {
      let entered = false;
      const waiting = withRepoLock(
        repo,
        () => {
          entered = true;
          return Promise.resolve();
        },
        { dir: locks, pollMs: 5 },
      );
      await sleep(100);
      expect(entered).toBe(false);
      rmSync(join(locks, name), { recursive: true, force: true }); // the other process is done
      await waiting;
      expect(entered).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
    await new Promise((done) => child.once('exit', done));

    // Its holder died without releasing it: taken over at once.
    mkdirSync(join(locks, name));
    writeFileSync(join(locks, name, 'owner'), `${child.pid} gone`);
    await withRepoLock(repo, () => Promise.resolve(), { dir: locks, pollMs: 5, staleMs: 60_000 });
    // A lock older than staleMs is taken over too, even when its pid looks alive.
    mkdirSync(join(locks, name));
    writeFileSync(join(locks, name, 'owner'), `${process.ppid} hung`);
    await sleep(30);
    await withRepoLock(repo, () => Promise.resolve(), { dir: locks, pollMs: 5, staleMs: 10 });
    expect(readdirSync(locks)).toEqual([]);
  });

  it('runs anyway when the lock folder cannot be made', async () => {
    const file = join(dir, 'not-a-folder');
    writeFileSync(file, '');
    expect(await withRepoLock(join(dir, 'repo'), () => Promise.resolve(7), { dir: join(file, 'x') })).toBe(7);
  });
});

describe('retryGitLock', () => {
  const locked = new ExecError(
    'git fetch',
    1,
    "error: cannot lock ref 'refs/remotes/origin/main': Unable to create '/r/.git/refs/remotes/origin/main.lock': File exists.",
  );

  it('retries git only when it found the repo locked', async () => {
    let calls = 0;
    expect(
      await retryGitLock(() => (++calls < 3 ? Promise.reject(locked) : Promise.resolve('ok')), [1, 1, 1]),
    ).toBe('ok');
    expect(calls).toBe(3);

    calls = 0;
    await expect(retryGitLock(() => (calls++, Promise.reject(locked)), [1, 1])).rejects.toBe(locked);
    expect(calls).toBe(3);

    calls = 0;
    const denied = new ExecError('git fetch', 128, 'git@github.com: Permission denied (publickey).');
    await expect(retryGitLock(() => (calls++, Promise.reject(denied)), [1, 1])).rejects.toBe(denied);
    expect(calls).toBe(1);
  });

  it("recognises git's lock messages", () => {
    expect(isGitLockError(locked.stderr)).toBe(true);
    expect(
      isGitLockError(
        "fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running",
      ),
    ).toBe(true);
    expect(isGitLockError("error: cannot lock ref 'refs/heads/x': is at 1a2b but expected 3c4d")).toBe(true);
    expect(isGitLockError('fatal: not a git repository')).toBe(false);
  });
});
