import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  opencodePermission,
  parseClaudeOutput,
  parseOpencodeOutput,
  runCommand,
  type OpencodeRule,
  type Runner,
} from '@loop-engineering/runner';
import type { AgentJob, AgentJobResult, AgentLauncher, JobRights } from './ports.js';

/** Headless Playwright MCP for QA jobs (the same package sessions get, without a visible browser). */
export const PLAYWRIGHT_MCP = ['npx', '-y', '@playwright/mcp@latest', '--headless', '--isolated'];

const LOOK_TOOLS = ['Read', 'Grep', 'Glob', 'LS'];
const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];
const WEB_TOOLS = ['WebFetch', 'WebSearch'];

/** Claude Code tool flags for `rights`. dontAsk mode denies anything not allowed here. */
export function claudeToolFlags(rights: JobRights): { allowed: string[]; disallowed: string[] } {
  const allowed = [...LOOK_TOOLS];
  const disallowed = ['Task', 'Agent'];
  (rights.edit ? allowed : disallowed).push(...EDIT_TOOLS);
  (rights.web ? allowed : disallowed).push(...WEB_TOOLS);
  if (rights.bash === 'all') {
    allowed.push('Bash');
    disallowed.push(...(rights.denyCommands ?? []).map((prefix) => `Bash(${prefix}:*)`));
  } else if (rights.bash.length === 0) disallowed.push('Bash');
  // Deny rules win over allow rules, so Bash itself is never denied when some commands are allowed.
  else allowed.push(...rights.bash.map((prefix) => `Bash(${prefix}:*)`));
  if (rights.playwright) allowed.push('mcp__playwright');
  return { allowed, disallowed };
}

/** The same rights for OpenCode: every key set explicitly, nothing left at "ask" (no one would answer). */
export function opencodeJobPermission(rights: JobRights): Record<string, OpencodeRule> {
  const rules = opencodePermission('dontAsk'); // "*" and every key deny; look tools and read allowed
  rules.edit = rights.edit ? 'allow' : 'deny';
  rules.webfetch = rules.websearch = rights.web ? 'allow' : 'deny';
  if (rights.bash === 'all') {
    // The last matching pattern wins, so the denials come after the catch-all.
    const bash: Record<string, 'allow' | 'deny'> = { '*': 'allow' };
    for (const prefix of rights.denyCommands ?? []) {
      bash[prefix] = 'deny';
      bash[`${prefix} *`] = 'deny';
    }
    rules.bash = bash;
  } else {
    const bash: Record<string, 'allow' | 'deny'> = { '*': 'deny' };
    for (const prefix of rights.bash) bash[`${prefix}*`] = 'allow';
    rules.bash = bash;
  }
  if (rights.playwright) rules['playwright_*'] = 'allow';
  return rules;
}

export interface CliAgentOptions {
  /** Default "claude". */
  claude?: string;
  /** Default "opencode". */
  opencode?: string;
  /** Where the allowlisted variables come from. Default process.env. */
  sourceEnv?: Record<string, string | undefined>;
  /** Set on top of the job environment (tests: fake binaries' state files). */
  extraEnv?: Record<string, string>;
  /** An empty folder for GH_CONFIG_DIR. Default: a folder under the OS temp dir. */
  ghConfigDir?: string;
  run?: Runner;
}

const JOB_SETTINGS = JSON.stringify({ disableAllHooks: true });

/**
 * Variables a job inherits from the server (the toolchain and the model provider's login); nothing
 * else, so DASHBOARD_TOKEN, MCP_TOKEN, TELEGRAM_*, GH_TOKEN, cloud keys and SSH_AUTH_SOCK never reach it.
 */
export const JOB_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TZ',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const;

/**
 * A job's environment: the allowlist, plus settings that leave gh and git without credentials (an
 * empty gh config, no credential helper, no system git config, no prompts, ssh disabled), so a job
 * cannot push, merge or call the GitHub API as the user. The loop does those itself.
 */
export function jobEnvironment(
  source: Record<string, string | undefined>,
  ghConfigDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of JOB_ENV_ALLOWLIST) {
    const value = source[name];
    if (value) env[name] = value;
  }
  return {
    ...env,
    GH_CONFIG_DIR: ghConfigDir,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_SSH_COMMAND: 'false',
  };
}

/** argv and environment for one job. Pure; exported for tests. */
export function buildJobCommand(
  job: AgentJob,
  bins: { claude: string; opencode: string } = { claude: 'claude', opencode: 'opencode' },
): { bin: string; args: string[]; env: Record<string, string>; input?: string } {
  if (job.provider === 'claude') {
    const { allowed, disallowed } = claudeToolFlags(job.rights);
    const mcp = job.rights.playwright
      ? JSON.stringify({
          mcpServers: {
            playwright: { type: 'stdio', command: PLAYWRIGHT_MCP[0], args: PLAYWRIGHT_MCP.slice(1) },
          },
        })
      : null;
    const args = [
      '-p',
      // stream-json: events as they happen (for the stage terminal); its last line is the same
      // result object plain json prints.
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      job.model,
      ...(job.effort ? ['--effort', job.effort] : []),
      '--permission-mode',
      'dontAsk',
      '--no-session-persistence',
      // User settings only: the checkout is PR content, so its .claude/settings*.json (permission
      // rules, hooks) must not apply. No hooks at all, the user's included.
      '--setting-sources',
      'user',
      '--settings',
      JOB_SETTINGS,
      '--append-system-prompt',
      job.systemPrompt,
      // Only the servers given here: no repo .mcp.json, no user servers.
      ...(mcp ? ['--mcp-config', mcp] : []),
      '--strict-mcp-config',
      // Variadic lists last, so they never swallow another argument. The prompt goes on stdin.
      '--allowedTools',
      ...allowed,
      '--disallowedTools',
      ...disallowed,
    ];
    return { bin: bins.claude, args, env: {}, input: job.prompt };
  }
  const config = {
    $schema: 'https://opencode.ai/config.json',
    permission: opencodeJobPermission(job.rights),
    ...(job.rights.playwright
      ? { mcp: { playwright: { type: 'local', command: PLAYWRIGHT_MCP, enabled: true } } }
      : {}),
  };
  // OpenCode has no system-prompt flag: it goes at the top of the message, as the runner does.
  const message = `${job.systemPrompt}\n\n${job.prompt}`;
  return {
    bin: bins.opencode,
    args: ['run', '--standalone', '--format', 'json', '-m', job.model, '--', message],
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
  };
}

/** Runs jobs with the Claude CLI (`claude -p`) or, for a session on the fallback, `opencode run`. */
export class CliAgentLauncher implements AgentLauncher {
  private readonly bins: { claude: string; opencode: string };
  private readonly sourceEnv: Record<string, string | undefined>;
  private readonly extraEnv: Record<string, string>;
  private readonly ghConfigDir: string;
  private readonly exec: Runner;

  constructor(options: CliAgentOptions = {}) {
    this.bins = { claude: options.claude ?? 'claude', opencode: options.opencode ?? 'opencode' };
    this.sourceEnv = options.sourceEnv ?? process.env;
    this.extraEnv = options.extraEnv ?? {};
    this.ghConfigDir = options.ghConfigDir ?? join(tmpdir(), 'loop-engineering-jobs-gh');
    this.exec = options.run ?? runCommand;
  }

  async run(job: AgentJob, signal: AbortSignal): Promise<AgentJobResult> {
    const cmd = buildJobCommand(job, this.bins);
    mkdirSync(this.ghConfigDir, { recursive: true, mode: 0o700 });
    const log = job.logFile ? openLog(job) : null;
    let exit = 'killed';
    try {
      const out = await this.exec(cmd.bin, cmd.args, {
        ...(log ? { onOutput: (chunk: string) => log.write(chunk) } : {}),
        cwd: job.cwd,
        env: { ...jobEnvironment(this.sourceEnv, this.ghConfigDir), ...this.extraEnv, ...cmd.env },
        cleanEnv: true,
        input: cmd.input,
        signal,
      });
      exit = `exit ${String(out.code)}`;
      const parsed =
        job.provider === 'claude'
          ? parseClaudeOutput(out.stdout, out.stderr)
          : parseOpencodeOutput(out.stdout, out.stderr);
      if (out.code !== 0 && !parsed.isError) parsed.isError = true;
      return parsed;
    } finally {
      // Also when the job is stopped or times out: the log file is always closed.
      log?.end(`\n=== ${exit} ===\n`);
    }
  }
}

/** Appends to the job's log: one header per run, so later rounds follow earlier ones in one file. */
function openLog(job: AgentJob): WriteStream {
  mkdirSync(dirname(job.logFile!), { recursive: true, mode: 0o700 });
  const log = createWriteStream(job.logFile!, { flags: 'a', mode: 0o600 });
  log.on('error', () => undefined); // a log problem never fails the job
  log.write(`\n=== ${job.kind} · ${job.provider}/${job.model} · ${new Date().toISOString()} ===\n`);
  return log;
}
