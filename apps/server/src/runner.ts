import { isAbsolute } from 'node:path';
import type { Store } from '@loop-engineering/core';
import {
  AGENT_ENV_ALLOWLIST,
  DEFAULT_MCP_TOKEN_ENV,
  DefaultAgentCli,
  nodeFs,
  RealGitDriver,
  RealTmuxDriver,
  SessionRunner,
  TMUX_CLIENT_ENV,
  type RunnerConfig,
} from '@loop-engineering/runner';
import { ConfigError, type ServerConfig } from './config.js';

/** The server's own secrets, wherever they were set (.env, the shell, a service file). */
export const SERVER_SECRET_ENV = [
  'DASHBOARD_TOKEN',
  'DASHBOARD_PASSWORD',
  'DASHBOARD_SESSION_SECRET',
  DEFAULT_MCP_TOKEN_ENV,
] as const;

/**
 * Names the runner removes from the tmux server's global environment before each window: the
 * server's secrets and everything .env sets, except what agents and tmux get anyway (the allowlists).
 * A tmux server the runner starts never holds them; one started earlier, by an older version or from
 * a shell with them exported, may.
 */
export function hiddenTmuxEnv(envFileNames: readonly string[]): string[] {
  const kept = new Set<string>([...AGENT_ENV_ALLOWLIST, ...TMUX_CLIENT_ENV]);
  return [...new Set([...SERVER_SECRET_ENV, ...envFileNames])].filter(
    (name) => !kept.has(name) && !/^LC_/.test(name),
  );
}

/**
 * The factory for the server's one SessionRunner (tmux, git, the claude / opencode CLIs), or null
 * when WORKTREES_ROOT is not set. Pass it to createServer as `runner`.
 */
export function runnerFromEnv(
  env: NodeJS.ProcessEnv,
  config: ServerConfig,
  options: Pick<RunnerConfig, 'planner'> & {
    /** The names .env sets (rootEnvNames()): kept out of the tmux server's global environment too. */
    envFileNames?: readonly string[];
  } = {},
): ((store: Store) => SessionRunner) | null {
  const { envFileNames = [], ...runnerOptions } = options;
  const worktreesRoot = env.WORKTREES_ROOT?.trim();
  if (!worktreesRoot) return null;
  if (!isAbsolute(worktreesRoot)) throw new ConfigError('WORKTREES_ROOT must be an absolute path');
  const serverUrl = config.publicUrl ?? `http://${config.host}:${config.port}`;
  const unsetGlobalEnv = hiddenTmuxEnv(envFileNames);
  return (store) =>
    new SessionRunner(
      {
        store,
        tmux: new RealTmuxDriver({ unsetGlobalEnv }),
        git: new RealGitDriver(),
        fs: nodeFs,
        agentCli: new DefaultAgentCli(),
      },
      // Builders wait out Claude's usage limit (the monitor resumes them) instead of moving to a free
      // model, which stalls on long building work. CLAUDE_LIMIT=opencode restores the switch.
      {
        worktreesRoot,
        serverUrl,
        env,
        onClaudeLimit: env.CLAUDE_LIMIT?.trim() === 'opencode' ? 'opencode' : 'wait',
        ...runnerOptions,
      },
    );
}
