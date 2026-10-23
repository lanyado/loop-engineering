import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AbortedError, CommandError, runCommand, runOk } from './run-command.js';

// Runs node itself, never claude or opencode.
const node = process.execPath;

describe('runCommand', () => {
  it('passes stdin and env, and resolves with the exit code and output', async () => {
    const script =
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(s+process.env.X);process.exit(3)})';
    expect(await runCommand(node, ['-e', script], { input: 'hello ', env: { X: 'world' } })).toEqual({
      code: 3,
      stdout: 'hello world\n',
      stderr: '',
    });
  });

  it('kills the process and rejects when the signal aborts', async () => {
    const controller = new AbortController();
    const running = runCommand(node, ['-e', 'setTimeout(() => {}, 60000)'], { signal: controller.signal });
    controller.abort(new Error('timeout'));
    await expect(running).rejects.toThrow(/was stopped/);
  });

  it('rejects when the binary does not exist', async () => {
    await expect(runCommand('/nonexistent/claude-binary', [])).rejects.toThrow(/ENOENT/);
  });

  it(
    'kills the whole process group on abort, not only the CLI (children too)',
    { timeout: 15_000 },
    async () => {
      const controller = new AbortController();
      const pidFile = join(tmpdir(), `loop-pg-${process.pid}-${Date.now()}`);
      // The CLI starts a child that ignores SIGTERM, records its pid, then both wait.
      const script = `sh -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 30' & wait`;
      const running = runCommand('sh', ['-c', script], { signal: controller.signal });
      let child = 0;
      for (let i = 0; i < 100 && !child; i++) {
        await new Promise((r) => setTimeout(r, 50));
        child = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim());
      }
      expect(child).toBeGreaterThan(0);
      controller.abort();
      await expect(running).rejects.toThrow(AbortedError);
      const alive = () => {
        try {
          process.kill(child, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 160 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(alive()).toBe(false);
      await rm(pidFile, { force: true });
    },
  );

  it('runs with exactly the given environment when cleanEnv is set', async () => {
    process.env.LOOP_TEST_SECRET = 'x';
    try {
      const out = await runCommand('sh', ['-c', 'echo "${LOOP_TEST_SECRET:-none} $ONLY"'], {
        env: { PATH: process.env.PATH, ONLY: 'yes' },
        cleanEnv: true,
      });
      expect(out.stdout.trim()).toBe('none yes');
    } finally {
      delete process.env.LOOP_TEST_SECRET;
    }
  });

  it(
    'ends what a job left running in the background after it exits normally',
    { timeout: 15_000 },
    async () => {
      const pidFile = join(tmpdir(), `loop-bg-${process.pid}-${Date.now()}`);
      const result = await runCommand('sh', [
        '-c',
        `sleep 30 > /dev/null 2>&1 & echo $! > ${pidFile}; exit 0`,
      ]);
      expect(result.code).toBe(0);
      const child = Number((await readFile(pidFile, 'utf8')).trim());
      const alive = () => {
        try {
          process.kill(child, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(alive()).toBe(false);
      await rm(pidFile, { force: true });
    },
  );

  it('runOk returns stdout and throws CommandError on a non-zero exit', async () => {
    expect(await runOk(runCommand, node, ['-e', 'console.log("hi")'])).toBe('hi\n');
    await expect(runOk(runCommand, node, ['-e', 'process.exit(2)'])).rejects.toThrow(CommandError);
  });
});
