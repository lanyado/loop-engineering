import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEAVY_SCRIPT, ScriptHeavySlots } from './heavy.js';

const hasFlock = spawnSync('sh', ['-c', 'command -v flock']).status === 0;

/** The real script: it is one small bash file with nothing to fake but its lock folder. */
describe.skipIf(!hasFlock)('scripts/heavy', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heavy-'));
    vi.stubEnv('LOOP_HEAVY_DIR', dir);
    vi.stubEnv('LOOP_HEAVY_SLOTS', '1');
    vi.stubEnv('LOOP_HEAVY_POLL_SECONDS', '0.05');
    vi.stubEnv('LOOP_HEAVY_HELD', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (...args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(HEAVY_SCRIPT, args, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        resolve({ code, stdout, stderr });
      });
    });

  it('returns the exit code and output of the command', async () => {
    expect(await run('sh', '-c', 'echo hi; exit 7')).toMatchObject({ code: 7, stdout: 'hi\n' });
    expect((await run('no-such-command-here')).code).toBe(127);
    expect((await run()).code).toBe(2);
  });

  it('waits for a free slot instead of failing, then runs', async () => {
    const slots = new ScriptHeavySlots();
    const release = await slots.acquire(new AbortController().signal);
    let done = false;
    const second = run('sh', '-c', 'echo ran').then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    release();
    expect(await second).toMatchObject({
      code: 0,
      stdout: 'ran\n',
      stderr: expect.stringContaining('busy') as string,
    });
  });

  it('frees the slot when the command ends, even if it left a server behind', async () => {
    // A background process that outlives the command must not keep the lock.
    await run('sh', '-c', 'sleep 6 >/dev/null 2>&1 &');
    const started = Date.now();
    expect((await run('true')).code).toBe(0);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('stops a command at the time limit, TERM then KILL, and frees its slot (B1)', async () => {
    vi.stubEnv('LOOP_HEAVY_MAX_SECONDS', '1');
    vi.stubEnv('LOOP_HEAVY_GRACE_SECONDS', '1');
    const started = Date.now();
    const out = await run('sh', '-c', 'trap "" TERM; sleep 60 & wait; sleep 60');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out.code).not.toBe(0);
    expect(out.stderr).toMatch(/over the limit/);
    vi.stubEnv('LOOP_HEAVY_MAX_SECONDS', '');
    expect((await run('true')).code).toBe(0);
  }, 20_000);

  it('runs the command without a limit when the lock folder cannot be used (B1)', async () => {
    vi.stubEnv('LOOP_HEAVY_DIR', '/proc/no-such-folder/heavy');
    const out = await run('sh', '-c', 'echo ran; exit 3');
    expect(out).toMatchObject({ code: 3, stdout: 'ran\n' });
    expect(out.stderr).toMatch(/without a limit/);
  }, 10_000);

  it('returns as soon as the command ends: nothing of its own holds the output open', async () => {
    const started = Date.now();
    expect((await run('true')).code).toBe(0);
    expect(Date.now() - started).toBeLessThan(700);
  });

  it('keeps the engine slot past the time limit: the job timer bounds it', async () => {
    vi.stubEnv('LOOP_HEAVY_MAX_SECONDS', '1');
    const release = await new ScriptHeavySlots().acquire(new AbortController().signal);
    await new Promise((r) => setTimeout(r, 2500));
    let done = false;
    const next = run('true').then(() => (done = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    release();
    await next;
    expect(done).toBe(true);
  }, 10_000);

  it('a killed heavy takes its command along, as one process group', async () => {
    const pidFile = join(dir, 'pid');
    const child = spawn('setsid', [HEAVY_SCRIPT, 'sh', '-c', `echo $$ > ${pidFile}; exec sleep 30`], {
      stdio: 'ignore',
    });
    await vi.waitFor(() => expect(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()).toBeTruthy(), {
      timeout: 3000,
    });
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    process.kill(-child.pid!, 'SIGKILL');
    await vi.waitFor(
      () => {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      },
      { timeout: 3000 },
    );
  }, 10_000);

  it.skipIf(spawnSync('sh', ['-c', 'command -v tmux']).status !== 0)(
    'a command can read a real terminal',
    async () => {
      const socket = `heavy-tty-${process.pid}`;
      const out = join(dir, 'typed');
      const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, ...args]);
      tmux('new-session', '-d', '-s', 't', `${HEAVY_SCRIPT} sh -c 'read x; echo "$x" > ${out}'`);
      try {
        await new Promise((r) => setTimeout(r, 500));
        tmux('send-keys', '-t', 't', 'hello', 'Enter');
        await vi.waitFor(() => expect(existsSync(out) && readFileSync(out, 'utf8').trim()).toBe('hello'), {
          timeout: 3000,
        });
      } finally {
        tmux('kill-server');
        // tmux leaves the socket file behind.
        rmSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`, socket), {
          force: true,
        });
      }
    },
    10_000,
  );

  it('runs nested calls straight away, inside the slot it already has', async () => {
    const out = await run(HEAVY_SCRIPT, 'sh', '-c', 'echo nested');
    expect(out).toMatchObject({ code: 0, stdout: 'nested\n' });
  });

  it('a wait aborted before a slot comes rejects with the reason, and holds nothing', async () => {
    const slots = new ScriptHeavySlots();
    const release = await slots.acquire(new AbortController().signal);
    const controller = new AbortController();
    const waiting = slots.acquire(controller.signal);
    await new Promise((r) => setTimeout(r, 100));
    const why = new Error('stopped');
    controller.abort(why);
    await expect(waiting).rejects.toBe(why);
    release();
    const next = await slots.acquire(new AbortController().signal);
    next();
  });

  it('lets jobs go ahead when the script cannot run', async () => {
    const release = await new ScriptHeavySlots('/no/such/script').acquire(new AbortController().signal);
    expect(release()).toBeUndefined();
  });
});
