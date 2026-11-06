import { spawn } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export class ExecError extends Error {
  constructor(
    readonly command: string,
    /** The exit code; a string for a spawn error (ENOENT); null when a signal ended it (a timeout too). */
    readonly code: number | string | null,
    /** What the command printed on stderr (empty when it printed nothing), or why it could not run. */
    readonly stderr: string,
    /** What the command printed before it failed. */
    readonly stdout = '',
  ) {
    super(`${command} failed (${String(code)}): ${stderr.trim()}`);
    this.name = 'ExecError';
  }
}

export interface ExecOptions {
  /**
   * Stop the command after this long. It runs in a process group of its own, and the whole group
   * gets SIGTERM, then SIGKILL after `killGraceMs`: a filter, ssh or credential helper git started
   * goes with it, not only git.
   */
  timeoutMs?: number;
  /** Between SIGTERM and SIGKILL on a timeout. Default 2 s. */
  killGraceMs?: number;
  /** Exactly the environment the command gets. Default process.env. */
  env?: Record<string, string | undefined>;
  /** Most bytes kept of stdout and of stderr. Default 16 MB. */
  maxBuffer?: number;
  /**
   * What happens past `maxBuffer`: "fail" (default) stops the command and rejects; "truncate" keeps
   * the first `maxBuffer` bytes and lets it finish.
   */
  overflow?: 'fail' | 'truncate';
}

const MAX_BUFFER = 16 * 1024 * 1024;
const KILL_GRACE_MS = 2000;

/** Runs a binary without a shell, so arguments never need quoting. Rejects with ExecError. */
export function exec(
  bin: string,
  args: string[],
  cwd?: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const command = `${bin} ${args.join(' ')}`;
    const timed = options.timeoutMs !== undefined;
    // Only a command with a time limit gets its own process group (and session): that is what a
    // timeout signals. The others (tmux) run as before.
    const child = spawn(bin, args, {
      cwd,
      // The cast is needed only in the dashboard's type check, which also compiles this file: Next's
      // types make NODE_ENV a required key of ProcessEnv there.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      env: options.env as NodeJS.ProcessEnv | undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: timed,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    /** Why we stopped it ourselves, if we did. */
    let stopped: string | null = null;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    const signalAll = (signal: NodeJS.Signals) => {
      try {
        if (timed && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // ESRCH: the group is gone already
      }
    };
    /** Our ends of its pipes: a pipeline still writing gets SIGPIPE, and 'close' is not held up. */
    const closePipes = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const stop = (why: string) => {
      if (stopped !== null || settled) return;
      stopped = why;
      // Past the output limit nothing more is read: stop whatever still writes.
      if (why.includes('maxBuffer')) closePipes();
      signalAll('SIGTERM');
      const kill = setTimeout(() => {
        signalAll('SIGKILL');
        // A process that left the group but holds our pipes would keep 'close' away: give up on it.
        const giveUp = setTimeout(() => finish(null, 'SIGKILL'), 1000);
        giveUp.unref();
        timers.push(giveUp);
      }, options.killGraceMs ?? KILL_GRACE_MS);
      kill.unref();
      timers.push(kill);
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      // Whatever the group still holds after a timeout dies now, not after the grace; and a process
      // that left the group but still holds the pipes loses them.
      if (stopped !== null) {
        signalAll('SIGKILL');
        closePipes();
      }
      const stdout = Buffer.concat(out).toString();
      const stderr = Buffer.concat(err).toString();
      if (stopped !== null) {
        const note = stderr.trim() === '' ? stopped : `${stderr.trimEnd()}\n${stopped}`;
        reject(
          new ExecError(
            command,
            stopped.startsWith('stdout') ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : null,
            note,
            stdout,
          ),
        );
      } else if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new ExecError(
            command,
            code,
            signal && stderr.trim() === '' ? `killed by ${signal}` : stderr,
            stdout,
          ),
        );
    };

    if (timed) {
      const timer = setTimeout(() => stop(`timed out after ${options.timeoutMs} ms`), options.timeoutMs);
      timer.unref();
      timers.push(timer);
    }
    const max = options.maxBuffer ?? MAX_BUFFER;
    const truncate = options.overflow === 'truncate';
    child.stdout.on('data', (d: Buffer) => {
      const room = max - outBytes;
      outBytes += d.length;
      if (outBytes <= max) out.push(d);
      else if (truncate) {
        if (room > 0) out.push(d.subarray(0, room));
      } else stop('stdout maxBuffer length exceeded');
    });
    child.stderr.on('data', (d: Buffer) => {
      const room = max - errBytes;
      errBytes += d.length;
      if (errBytes <= max) err.push(d);
      else if (truncate) {
        if (room > 0) err.push(d.subarray(0, room));
      } else stop('stderr maxBuffer length exceeded');
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      // After we stopped it ('close' still comes): a failed kill must not drop what it printed.
      if (settled || stopped !== null) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      reject(new ExecError(command, e.code ?? null, e.message));
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
