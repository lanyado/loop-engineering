import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  /** Merged over process.env, unless `cleanEnv`. */
  env?: Record<string, string | undefined>;
  /** Run with exactly `env` (nothing inherited from process.env), e.g. for agent jobs. */
  cleanEnv?: boolean;
  /** Written to stdin, which is then closed. */
  input?: string;
  /** Kills the process and everything it started (SIGTERM, then SIGKILL after 5 s). */
  signal?: AbortSignal;
  /** Called with each chunk of stdout and stderr as it arrives (e.g. to stream it to a log). */
  onOutput?: (chunk: string) => void;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly result: RunResult,
  ) {
    super(
      `${command} failed (${String(result.code)}): ${(result.stderr || result.stdout).trim().slice(0, 2000)}`,
    );
    this.name = 'CommandError';
  }
}

export class AbortedError extends Error {
  constructor(command: string) {
    super(`${command} was stopped (timeout or shutdown)`);
    this.name = 'AbortedError';
  }
}

/** Runs a binary without a shell and resolves with its exit code and output (it never rejects on a non-zero exit). */
export type Runner = (bin: string, args: string[], options?: RunOptions) => Promise<RunResult>;

const MAX_OUTPUT = 32 * 1024 * 1024;

export const runCommand: Runner = (bin, args, options = {}) =>
  new Promise((resolve, reject) => {
    const command = [bin, ...args.slice(0, 3)].join(' ');
    if (options.signal?.aborted) {
      reject(new AbortedError(command));
      return;
    }
    // The cast is needed only in the dashboard's type check, which also compiles this file: Next's
    // types make NODE_ENV a required key of ProcessEnv there.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const env = (
      options.cleanEnv ? { ...options.env } : options.env ? { ...process.env, ...options.env } : process.env
    ) as NodeJS.ProcessEnv;
    // detached: its own process group, so a kill reaches the dev servers, test runners and browsers
    // a job starts, not only the CLI.
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal); // the group is already gone
      }
    };
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      aborted = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 5000);
      killTimer.unref();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
      options.onOutput?.(d.toString());
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
      options.onOutput?.(d.toString());
    });
    child.stdin.on('error', () => undefined); // the process may exit before reading its input
    child.stdin.end(options.input ?? '');
    child.on('error', (err) => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort);
      // After an abort the SIGKILL stays scheduled: children that ignore SIGTERM still die.
      if (killTimer && !aborted) clearTimeout(killTimer);
      // After a normal exit too: dev servers, watchers and browsers the job left behind go with it.
      if (!aborted && child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // ESRCH: nothing left in the group
        }
      }
      if (aborted) reject(new AbortedError(command));
      else resolve({ code, stdout, stderr });
    });
  });

/** Runs and returns stdout; throws CommandError on a non-zero exit. */
export async function runOk(run: Runner, bin: string, args: string[], options?: RunOptions): Promise<string> {
  const result = await run(bin, args, options);
  if (result.code !== 0) throw new CommandError(`${bin} ${args.join(' ')}`, result);
  return result.stdout;
}
