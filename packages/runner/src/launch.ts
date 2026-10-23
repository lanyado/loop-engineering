/** POSIX single-quote quoting: safe for any string, newlines included. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A /bin/sh script that sets the agent's environment and execs it. The runner writes it to a
 * private file and has tmux run `sh <file>`, instead of putting the command on tmux's command line:
 * long continuation prompts would exceed tmux's message size, and secrets (the ask_human token) would
 * show in `ps` for the tmux client. The script deletes itself once the shell has opened it.
 */
export function renderLaunchScript(argv: string[], env: Record<string, string>, cwd: string): string {
  const lines = ['#!/bin/sh', 'rm -f -- "$0"', `cd ${shellQuote(cwd)} || exit 1`];
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name)) throw new Error(`invalid environment variable name: ${name}`);
    lines.push(`export ${name}=${shellQuote(value)}`);
  }
  lines.push(`exec ${argv.map(shellQuote).join(' ')}`, '');
  return lines.join('\n');
}
