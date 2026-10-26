import { isAbsolute } from 'node:path';
import type { Store } from '@loop-engineering/core';
import {
  DefaultAgentCli,
  nodeFs,
  RealGitDriver,
  RealTmuxDriver,
  SessionRunner,
  type RunnerConfig,
} from '@loop-engineering/runner';
import { ConfigError, type ServerConfig } from './config.js';

/**
 * The factory for the server's one SessionRunner (tmux, git, the claude / opencode CLIs), or null
 * when WORKTREES_ROOT is not set. Pass it to createServer as `runner`.
 */
export function runnerFromEnv(
  env: NodeJS.ProcessEnv,
  config: ServerConfig,
  options: Pick<RunnerConfig, 'planner'> = {},
): ((store: Store) => SessionRunner) | null {
  const worktreesRoot = env.WORKTREES_ROOT?.trim();
  if (!worktreesRoot) return null;
  if (!isAbsolute(worktreesRoot)) throw new ConfigError('WORKTREES_ROOT must be an absolute path');
  const serverUrl = config.publicUrl ?? `http://${config.host}:${config.port}`;
  return (store) =>
    new SessionRunner(
      {
        store,
        tmux: new RealTmuxDriver(),
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
        ...options,
      },
    );
}
