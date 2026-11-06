import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { Store } from '@loop-engineering/core';
import {
  AGENT_ENV_ALLOWLIST,
  DefaultAgentCli,
  nodeFs,
  parseAgentEnvExtra,
  RealGitDriver,
  RealTmuxDriver,
  SERVER_SECRET_ENV,
  SessionRunner,
  TMUX_CLIENT_ENV,
  type RunnerConfig,
} from '@loop-engineering/runner';
import { ConfigError, type ServerConfig } from './config.js';

/**
 * A warning when git is older than 2.31: the runner hands its git guard (a repo's own filters,
 * credential helpers and drivers neutralized) to git as GIT_CONFIG_COUNT, which older git ignores.
 * Null when git is new enough or its version is unknown.
 */
export function gitVersionWarning(versionOutput: string | null): string | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(versionOutput ?? '');
  if (!m) return null;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major > 2 || (major === 2 && minor >= 31)) return null;
  const version = [m[1], m[2], m[3]].filter((p) => p !== undefined).join('.');
  return (
    `warning: git ${version} is older than 2.31, so the runner's git cannot neutralize a repo's own ` +
    'filters, credential helpers and drivers (it needs GIT_CONFIG_COUNT); upgrade git'
  );
}

/** AGENT_ENV_EXTRA, checked at start: a malformed entry, or one naming a server secret, stops it. */
export function checkAgentEnvExtra(env: NodeJS.ProcessEnv): string[] {
  try {
    return parseAgentEnvExtra(env.AGENT_ENV_EXTRA);
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
}

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
  checkAgentEnvExtra(env);
  const worktreesRoot = env.WORKTREES_ROOT?.trim();
  if (!worktreesRoot) return null;
  if (!isAbsolute(worktreesRoot)) throw new ConfigError('WORKTREES_ROOT must be an absolute path');
  const serverUrl = config.publicUrl ?? `http://${config.host}:${config.port}`;
  const unsetGlobalEnv = hiddenTmuxEnv(envFileNames);
  let gitVersion: string | null = null;
  try {
    gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8', env: { PATH: env.PATH ?? '' } });
  } catch {
    // No git at all: the first session start says so.
  }
  const warning = gitVersionWarning(gitVersion);
  if (warning) console.warn(warning);
  return (store) =>
    new SessionRunner(
      {
        store,
        tmux: new RealTmuxDriver({ unsetGlobalEnv }),
        git: new RealGitDriver({ sourceEnv: env }),
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
