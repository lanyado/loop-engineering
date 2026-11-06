import { WINDOW_ENV } from './agent-env.js';

/** POSIX single-quote quoting: safe for any string, newlines included. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Passed to the script's second run, so it knows it runs in the clean environment. */
const CLEAN_RUN = '--clean-env';

/**
 * A /bin/sh script that runs the agent with exactly `env` (plus the window's terminal variables,
 * WINDOW_ENV) and nothing else. The runner writes it to a private file and has tmux run `sh <file>`,
 * instead of putting the command on tmux's command line: long continuation prompts would exceed
 * tmux's message size, and secrets (the ask_human token) would show in `ps` for the tmux client.
 *
 * The window starts with the tmux server's global environment, which holds whatever the server's
 * first client had: on a server someone else started, possibly secrets. So the script first runs
 * itself again under `/usr/bin/env -i` with only the window's terminal variables (none of `env`'s
 * values go on that command line), and that run sets `env`, deletes the file and execs the agent.
 */
export function renderLaunchScript(argv: string[], env: Record<string, string>, cwd: string): string {
  for (const name of Object.keys(env))
    if (!ENV_NAME.test(name)) throw new Error(`invalid environment variable name: ${name}`);
  const lines = [
    '#!/bin/sh',
    `if [ "$1" != ${CLEAN_RUN} ]; then`,
    `  set -- /bin/sh "$0" ${CLEAN_RUN}`,
    ...WINDOW_ENV.map((name) => `  [ -z "\${${name}+x}" ] || set -- "${name}=$${name}" "$@"`),
    '  [ -x /usr/bin/env ] || { rm -f -- "$0"; echo "launch: /usr/bin/env not found" >&2; exit 127; }',
    '  exec /usr/bin/env -i "$@"',
    'fi',
    'rm -f -- "$0"',
    `cd ${shellQuote(cwd)} || exit 1`,
    ...Object.entries(env).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    `exec ${argv.map(shellQuote).join(' ')}`,
    '',
  ];
  return lines.join('\n');
}
