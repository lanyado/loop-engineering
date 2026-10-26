import { execFile } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export class ExecError extends Error {
  constructor(
    readonly command: string,
    readonly code: number | string | null,
    readonly stderr: string,
  ) {
    super(`${command} failed (${String(code)}): ${stderr.trim()}`);
    this.name = 'ExecError';
  }
}

/** Runs a binary without a shell, so arguments never need quoting. */
export function exec(
  bin: string,
  args: string[],
  cwd?: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, timeout: options.timeoutMs, env: options.env },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number | string }).code ?? null;
          reject(new ExecError(`${bin} ${args.join(' ')}`, code, stderr || err.message));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}
