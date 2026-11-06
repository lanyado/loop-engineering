import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exec, ExecError } from './exec.js';
import { RealGitDriver } from './git.js';

/** Whether `pid` still runs (a zombie waiting for its parent to reap it counts as gone). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return true; // no /proc (macOS): kill(0) said it is there
  }
}

describe('exec', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loop-exec-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** The pid a fake command wrote to `file`, once it has. */
  const pidIn = async (file: string): Promise<number> => {
    await vi.waitFor(() => expect(existsSync(file) && readFileSync(file, 'utf8').trim()).toBeTruthy(), {
      timeout: 3000,
    });
    return Number(readFileSync(file, 'utf8').trim());
  };

  it('resolves with the output, and rejects with the exit code and only what the command printed', async () => {
    expect(await exec('sh', ['-c', 'echo out; echo err >&2'])).toEqual({ stdout: 'out\n', stderr: 'err\n' });
    const silent = await exec('sh', ['-c', 'echo partial; exit 3']).catch((e: unknown) => e);
    expect(silent).toBeInstanceOf(ExecError);
    // No stderr means an empty stderr, not a message that repeats the command line.
    expect(silent).toMatchObject({ code: 3, stderr: '', stdout: 'partial\n' });
    await expect(exec('/no/such/binary', [])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('on a timeout stops the command and everything it started, not only the command', async () => {
    // A slow child the command leaves running (as git leaves a filter, ssh or credential helper).
    const pidFile = join(dir, 'child.pid');
    const started = Date.now();
    const err = await exec('sh', ['-c', `sleep 30 & echo $! > '${pidFile}'; wait`], undefined, {
      timeoutMs: 300,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect(err).toMatchObject({ code: null, stderr: 'timed out after 300 ms' });
    expect(Date.now() - started).toBeLessThan(5000);
    const child = await pidIn(pidFile);
    await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 3000 });
  });

  it('kills what ignores SIGTERM after the grace', async () => {
    const pidFile = join(dir, 'stubborn.pid');
    const err = await exec(
      'sh',
      ['-c', `trap '' TERM; sleep 30 & echo $! > '${pidFile}'; wait; wait`],
      undefined,
      { timeoutMs: 200, killGraceMs: 300 },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: null, stderr: 'timed out after 200 ms' });
    const child = await pidIn(pidFile);
    await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 3000 });
  });

  it("stops a slow git and the helper it started when the repo's config read times out", async () => {
    // A fake git whose config read starts a slow helper and waits for it.
    const pidFile = join(dir, 'helper.pid');
    const fakeGit = join(dir, 'fake-git');
    writeFileSync(fakeGit, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nwait\n`, { mode: 0o755 });
    const driver = new RealGitDriver({
      bin: fakeGit,
      sourceEnv: { PATH: process.env.PATH },
      configTimeoutMs: 300,
    });
    await expect(driver.status(dir)).rejects.toThrow(
      /cannot read the git config in .*timed out after 300 ms/,
    );
    const helper = await pidIn(pidFile);
    await vi.waitFor(() => expect(alive(helper)).toBe(false), { timeout: 3000 });
  });
});
