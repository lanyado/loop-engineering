import { WINDOW_ENV } from './agent-env.js';
import { sanitizeLine } from './sanitize.js';

/** POSIX single-quote quoting: safe for any string, newlines included. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Starts every line the script prints about its own failure; launchFailure() finds them in the pane. */
const LAUNCH_PREFIX = 'launch:';

/** The script's own failure messages that name nothing of the session's (after "launch: "). */
const FIXED_MESSAGES = ['/usr/bin/env not found', 'cannot enter the working folder'];

/** What the launch script ran: its CLI (argv[0]) and the PATH it gave the agent. */
export interface LaunchedCli {
  cli: string;
  path: string;
}

/** The script's message for a CLI missing from PATH, exactly as it prints it (after "launch: "). */
function notFound({ cli, path }: LaunchedCli): string {
  return `${cli} not found (PATH=${path})`;
}

/**
 * What the launch script said about why the agent never started, from the dead pane's text: its
 * own messages, as one line, or null. Only the exact lines the script prints count: the fixed ones,
 * and "<cli> not found (PATH=<path>)" for the CLI and PATH it actually ran with (`launched`; without
 * it, that message is not accepted), so an agent printing "launch: ..." gets no words of its own in.
 * The runner also reads it only for a pane that died right after its launch, and puts it in the
 * session history, since the window is killed next.
 */
export function launchFailure(pane: string, launched?: LaunchedCli): string | null {
  const own = new Set(FIXED_MESSAGES);
  if (launched) own.add(sanitizeLine(notFound(launched)));
  const said = pane
    .split('\n')
    .map((l) => sanitizeLine(l))
    .filter((l) => l.startsWith(`${LAUNCH_PREFIX} `))
    .map((l) => l.slice(LAUNCH_PREFIX.length + 1))
    .filter((l) => own.has(l));
  if (said.length === 0) return null;
  const text = [...new Set(said)].join('; ');
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

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
    `  [ -x /usr/bin/env ] || { rm -f -- "$0"; echo "${LAUNCH_PREFIX} /usr/bin/env not found" >&2; exit 127; }`,
    '  exec /usr/bin/env -i "$@"',
    'fi',
    'rm -f -- "$0"',
    `cd ${shellQuote(cwd)} || { echo "${LAUNCH_PREFIX} cannot enter the working folder" >&2; exit 1; }`,
    ...Object.entries(env).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    // A CLI missing from the PATH the agent gets (the server's) is the likely failure: say so.
    `command -v ${shellQuote(argv[0] ?? '')} >/dev/null 2>&1 || { printf '${LAUNCH_PREFIX} %s not found (PATH=%s)\\n' ${shellQuote(argv[0] ?? '')} "$PATH" >&2; exit 127; }`,
    `exec ${argv.map(shellQuote).join(' ')}`,
    '',
  ];
  return lines.join('\n');
}
