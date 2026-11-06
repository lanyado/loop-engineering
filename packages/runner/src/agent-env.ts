/**
 * What an agent window's environment is built from. The server's environment holds its own secrets
 * (DASHBOARD_TOKEN, the shared MCP_TOKEN, the dashboard password, add-ins' keys from .env), and an
 * agent that read them could call /api as the owner and answer its own questions. So nothing reaches
 * an agent by inheritance: the launch script starts it under `env -i` with this allowlist (read from
 * the server's environment), the variables the runner sets for the session, and the terminal
 * variables tmux gives the window. tmux itself runs with tmuxClientEnvironment(), so a tmux server
 * the runner starts holds no secrets in its global environment either (every window inherits that,
 * and `tmux show-environment -g` prints it).
 */

/**
 * Variables an agent gets from the server's environment when they are set: the toolchain and locale,
 * the model provider's login (Claude Code: an API key or OAuth token, OpenCode keeps its own under
 * XDG_DATA_HOME), the user's git identity and GitHub access (builders push their branch and open a
 * PR with gh, as the instructions say), the SSH agent git may push through, proxies and CA bundles.
 * The PR loop's jobs get a narrower list (JOB_ENV_ALLOWLIST in packages/loop), without GitHub or SSH.
 */
export const AGENT_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TZ',
  'LANG',
  'LANGUAGE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_HOST',
  'SSH_AUTH_SOCK',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
] as const;

/**
 * Variables the tmux client runs with: enough to find the right server (TMUX, TMUX_TMPDIR), read the
 * user's tmux.conf and start a shell. A tmux server copies its first client's environment into its
 * global environment, which every window inherits, so this list holds no credentials at all.
 */
export const TMUX_CLIENT_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TZ',
  'LANG',
  'LANGUAGE',
  'TERM',
  'TMUX',
  'TMUX_TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
] as const;

/**
 * Set by tmux for the window itself (the terminal type, and how a program finds its own pane); the
 * launch script carries these from the window into the agent's clean environment.
 */
export const WINDOW_ENV = ['TERM', 'COLORTERM', 'TMUX', 'TMUX_PANE'] as const;

/**
 * Variables the runner's own git commands (status, diff, log, fetch, push, worktree) run with in
 * builders' repos: enough to fetch and push as the user (SSH agent, gh's credential helper, proxies,
 * CA bundles), none of the server's secrets. See RealGitDriver.
 */
export const GIT_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TZ',
  'LANG',
  'LANGUAGE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GIT_SSL_CAINFO',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
] as const;

/**
 * The server's own secrets. Never given to an agent, never accepted in AGENT_ENV_EXTRA, and removed
 * from the tmux server's global environment.
 */
export const SERVER_SECRET_ENV = [
  'DASHBOARD_TOKEN',
  'DASHBOARD_PASSWORD',
  'DASHBOARD_SESSION_SECRET',
  'MCP_TOKEN',
] as const;

/** Every LC_* locale variable passes too. */
const LOCALE = /^LC_[A-Z_]+$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** "AWS_*": every name starting with AWS_. At least two characters before the star. */
const PREFIX = /^([A-Za-z_][A-Za-z0-9_]+)\*$/;

/**
 * The names (NAME) and prefixes (PREFIX*) of AGENT_ENV_EXTRA, a comma-separated setting that adds
 * variables to the agent allowlist without editing the source (provider keys, AWS_* for Bedrock,
 * GOOGLE_* for Vertex). Throws on a malformed entry, or one that names or would cover a server
 * secret (SERVER_SECRET_ENV): those never reach an agent.
 */
export function parseAgentEnvExtra(value: string | undefined): string[] {
  const entries = (value ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  for (const entry of entries) {
    const prefix = PREFIX.exec(entry)?.[1];
    if (!prefix && !NAME.test(entry))
      throw new Error(
        `AGENT_ENV_EXTRA: "${entry}" is not a variable name or a prefix ending in * (e.g. AWS_*)`,
      );
    const covered = SERVER_SECRET_ENV.filter((secret) =>
      prefix ? secret.startsWith(prefix) : secret === entry,
    );
    if (covered.length > 0)
      throw new Error(`AGENT_ENV_EXTRA: "${entry}" would give agents the server's ${covered.join(', ')}`);
  }
  return entries;
}

function pick(
  source: Record<string, string | undefined>,
  names: readonly string[],
  prefixes: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value) env[name] = value;
  }
  for (const [name, value] of Object.entries(source))
    if (value && (LOCALE.test(name) || prefixes.some((p) => name.startsWith(p)))) env[name] = value;
  return env;
}

/**
 * The allowlisted part of an agent's environment, read from `source` (the server's): AGENT_ENV_ALLOWLIST
 * plus what source.AGENT_ENV_EXTRA adds. A malformed or refused AGENT_ENV_EXTRA adds nothing here
 * (the server refuses to start with one); a server secret is never included either way.
 */
export function agentBaseEnvironment(source: Record<string, string | undefined>): Record<string, string> {
  let extra: string[];
  try {
    extra = parseAgentEnvExtra(source.AGENT_ENV_EXTRA);
  } catch {
    extra = [];
  }
  const names = [...AGENT_ENV_ALLOWLIST, ...extra.filter((e) => !e.endsWith('*'))];
  const prefixes = extra.filter((e) => e.endsWith('*')).map((e) => e.slice(0, -1));
  const env = pick(source, names, prefixes);
  for (const secret of SERVER_SECRET_ENV) delete env[secret];
  return env;
}

/** The environment tmux commands run with, read from `source` (the server's). */
export function tmuxClientEnvironment(source: Record<string, string | undefined>): Record<string, string> {
  return pick(source, TMUX_CLIENT_ENV);
}

/** The environment the runner's git commands run with, read from `source` (the server's). */
export function gitEnvironment(source: Record<string, string | undefined>): Record<string, string> {
  return { ...pick(source, GIT_ENV_ALLOWLIST), GIT_TERMINAL_PROMPT: '0' };
}
