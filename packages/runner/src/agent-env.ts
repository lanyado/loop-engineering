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

/** Every LC_* locale variable passes too. */
const LOCALE = /^LC_[A-Z_]+$/;

function pick(source: Record<string, string | undefined>, names: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value) env[name] = value;
  }
  for (const [name, value] of Object.entries(source)) if (LOCALE.test(name) && value) env[name] = value;
  return env;
}

/** The allowlisted part of an agent's environment, read from `source` (the server's). */
export function agentBaseEnvironment(source: Record<string, string | undefined>): Record<string, string> {
  return pick(source, AGENT_ENV_ALLOWLIST);
}

/** The environment tmux commands run with, read from `source` (the server's). */
export function tmuxClientEnvironment(source: Record<string, string | undefined>): Record<string, string> {
  return pick(source, TMUX_CLIENT_ENV);
}
