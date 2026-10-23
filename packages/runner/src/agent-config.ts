import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionMode } from '@loop-engineering/core';
import type { Fs } from './drivers/fs.js';

/** File names inside a session's config folder (under the runner's stateDir, never in a worktree). */
export const CLAUDE_MCP_FILE = 'mcp.json';
export const OPENCODE_CONFIG_FILE = 'opencode.json';
/** The repo-level Claude MCP file; read (never written) so a repo's own servers stay available. */
export const REPO_MCP_FILE = '.mcp.json';
/** Skill folder, relative to the agent's working directory. */
export const SKILL_DIR = '.claude/skills/opensource-search';
export const SKILL_FILE = `${SKILL_DIR}/SKILL.md`;

/** Env var holding the bearer token sessions send to the ask_human MCP server (what apps/server reads). */
export const DEFAULT_MCP_TOKEN_ENV = 'MCP_TOKEN';

/** Optional API keys passed from the runner's env to the agent when set; MCP configs reference them. */
export const PASSTHROUGH_ENV = [
  'TAVILY_API_KEY',
  'CONTEXT7_API_KEY',
  'GITHUB_PERSONAL_ACCESS_TOKEN',
] as const;

export interface AgentConfigInput {
  /** Base URL of the always-on server; ask_human is served at `${serverUrl}/mcp`. */
  serverUrl: string;
  sessionId: number;
  tokenEnv: string;
  fallbackModel: string;
  permissionMode: PermissionMode;
}

interface ClaudeMcpServer {
  type: 'http' | 'stdio';
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
}

const PLAYWRIGHT = ['npx', '-y', '@playwright/mcp@latest'];

function askHumanUrl(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/mcp`;
}

/**
 * Claude Code MCP config. Secrets stay out of the file: Claude expands `${VAR}` (and `${VAR:-}` for
 * optional keys) from the launch environment. X-Loop-Session-Id tells ask_human which session asks.
 */
export function claudeMcpConfig(input: AgentConfigInput): { mcpServers: Record<string, ClaudeMcpServer> } {
  return {
    mcpServers: {
      ask_human: {
        type: 'http',
        url: askHumanUrl(input.serverUrl),
        headers: {
          Authorization: `Bearer \${${input.tokenEnv}}`,
          'X-Loop-Session-Id': String(input.sessionId),
        },
      },
      tavily: {
        type: 'http',
        url: 'https://mcp.tavily.com/mcp/',
        headers: { Authorization: 'Bearer ${TAVILY_API_KEY:-}' },
      },
      playwright: { type: 'stdio', command: PLAYWRIGHT[0], args: PLAYWRIGHT.slice(1) },
      context7: {
        type: 'http',
        url: 'https://mcp.context7.com/mcp',
        headers: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY:-}' },
      },
      github: {
        type: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN:-}' },
      },
    },
  };
}

export type OpencodePermission = 'ask' | 'allow' | 'deny';
/** A permission for every call of a tool, or per-pattern rules (the last matching pattern wins). */
export type OpencodeRule = OpencodePermission | Record<string, OpencodePermission>;

/** Every permission key OpenCode documents. Each is set explicitly, so a project config can't loosen one. */
export const OPENCODE_PERMISSION_KEYS = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'skill',
  'lsp',
  'question',
  'webfetch',
  'websearch',
  'external_directory',
  'doom_loop',
] as const;

/** Look-only tools Claude runs without asking in every mode. */
const LOOK_TOOLS = ['glob', 'grep', 'list', 'lsp'] as const;

/** OpenCode's own default for read, kept: env files are denied, their examples are not. */
const READ_RULE: Record<string, OpencodePermission> = {
  '*': 'allow',
  '*.env': 'deny',
  '*.env.*': 'deny',
  '*.env.example': 'allow',
};

/**
 * OpenCode has no permission modes, and most of its tools default to "allow". So every mapping starts
 * with a "*" catch-all for the mode (MCP tools and anything added later fall under it), then sets every
 * documented key explicitly: OpenCode merges configs key by key, so a key left out could be loosened
 * by a repo's own opencode.json.
 */
export function opencodePermission(mode: PermissionMode): Record<string, OpencodeRule> {
  const base: OpencodePermission =
    mode === 'bypassPermissions' ? 'allow' : mode === 'dontAsk' ? 'deny' : 'ask';
  const edit: Record<PermissionMode, OpencodePermission> = {
    bypassPermissions: 'allow',
    auto: 'allow', // Claude's auto relies on a safety classifier OpenCode lacks: edits allowed, the rest asks.
    acceptEdits: 'allow',
    manual: 'ask',
    plan: 'deny',
    dontAsk: 'deny',
  };
  if (mode === 'auto') return autoPermission();
  const rules: Record<string, OpencodeRule> = { '*': base };
  for (const key of OPENCODE_PERMISSION_KEYS) rules[key] = base;
  for (const key of LOOK_TOOLS) rules[key] = 'allow';
  rules.read = { ...READ_RULE };
  rules.edit = edit[mode];
  return rules;
}

/**
 * Shell commands auto mode refuses: merging, pushes that rewrite or land on the default branch, hard
 * resets and wiping root or home. A guard against mistakes, not a security boundary (a wrapped
 * command like `bash -c "..."` gets past it); the boundaries are the worktree-only folder rule and the
 * credentials in the agent's shell.
 */
const AUTO_DENIED_COMMANDS = [
  'gh pr merge*',
  'git push --force*',
  'git push -f*',
  'git push * --force*',
  'git push * -f*',
  'git push * +*',
  'git push --mirror*',
  'git push * main',
  'git push * *:main',
  'git push * master',
  'git push * *:master',
  'git reset --hard*',
  'git clean -f*',
  'sudo *',
  'rm -rf /',
  'rm -rf ~',
  'rm -rf ~/',
  'rm -rf $HOME',
  'rm -rf $HOME/',
] as const;

/**
 * The system temp folders, as given and resolved (macOS's /var/folders/... is /private/var/folders/...):
 * OpenCode checks both forms of a path.
 */
function tempDirs(): string[] {
  const dirs = [tmpdir(), '/tmp'];
  for (const d of [...dirs]) {
    try {
      dirs.push(realpathSync(d));
    } catch {
      // Missing folder: nothing to resolve.
    }
  }
  return [...new Set(dirs)];
}

/**
 * Auto mode for OpenCode. Claude's auto mode lets a safety classifier approve calls; OpenCode has
 * none, and an "ask" in an unwatched terminal stalls the session until someone opens it. So nothing
 * asks: ordinary work (commands, MCP tools, web, subagents) is allowed, and the risky calls are
 * denied, which the agent sees and can take to the human through ask_human.
 */
function autoPermission(): Record<string, OpencodeRule> {
  const rules: Record<string, OpencodeRule> = { '*': 'allow' };
  for (const key of OPENCODE_PERMISSION_KEYS) rules[key] = 'allow';
  rules.read = { ...READ_RULE };
  rules.bash = { '*': 'allow', ...Object.fromEntries(AUTO_DENIED_COMMANDS.map((c) => [c, 'deny'])) };
  // Outside the worktree, OpenCode's own question tool (nobody answers it) and merging stay off.
  // The temp dir is the exception: agents keep scratch scripts and screenshots there.
  rules.external_directory = {
    '*': 'deny',
    ...Object.fromEntries(tempDirs().map((d) => [`${d}/*`, 'allow'])),
  };
  rules.question = 'deny';
  rules.doom_loop = 'deny';
  rules.github_merge_pull_request = 'deny';
  return rules;
}

/** The same servers and rights for OpenCode, in its config format (`{env:VAR}` substitution). */
export function opencodeConfig(input: AgentConfigInput): Record<string, unknown> {
  const remote = (url: string, headers: Record<string, string>) => ({
    type: 'remote',
    url,
    headers,
    enabled: true,
  });
  return {
    $schema: 'https://opencode.ai/config.json',
    model: input.fallbackModel,
    permission: opencodePermission(input.permissionMode),
    mcp: {
      ask_human: remote(askHumanUrl(input.serverUrl), {
        Authorization: `Bearer {env:${input.tokenEnv}}`,
        'X-Loop-Session-Id': String(input.sessionId),
      }),
      tavily: remote('https://mcp.tavily.com/mcp/', { Authorization: 'Bearer {env:TAVILY_API_KEY}' }),
      playwright: { type: 'local', command: PLAYWRIGHT, enabled: true },
      context7: remote('https://mcp.context7.com/mcp', { CONTEXT7_API_KEY: '{env:CONTEXT7_API_KEY}' }),
      github: remote('https://api.githubcopilot.com/mcp/', {
        Authorization: 'Bearer {env:GITHUB_PERSONAL_ACCESS_TOKEN}',
      }),
    },
  };
}

export const OPENSOURCE_SEARCH_SKILL = `---
name: opensource-search
description: Mandatory before writing any new module, package, utility or integration. Search GitHub, npm and PyPI for an existing well-maintained library, then justify building vs reusing.
---

# Open-source search before building

Before you write a new module (a parser, client, queue, CLI wrapper, UI component, algorithm, anything
more than glue code), search for existing open-source code that already does it.

## Steps

1. Name the capability in two or three words (for example "tmux control", "cron parsing").
2. Search, using the tools you have (tavily for the web, the GitHub MCP for repositories and code,
   context7 for library docs):
   - GitHub: repositories and code matching the capability; note stars, last commit, open issues.
   - npm (\`https://www.npmjs.com/search?q=...\`) for JavaScript/TypeScript projects.
   - PyPI (\`https://pypi.org/search/?q=...\`) for Python projects.
3. Pick at most three candidates and check: maintained (a release or commit in the last year),
   license compatible with the project, install size and transitive dependencies, API fit, security
   advisories.
4. Decide:
   - **Reuse** when a candidate fits and is maintained. Add it with the project's package manager.
   - **Build** when nothing fits, candidates are unmaintained or too heavy, or the code is a few lines.

## Record the decision

Write the justification where reviewers see it: the PR description (and a code comment when the
choice is not obvious). One or two sentences: what you searched, what you found, and why you reused
or built. Example: "Searched npm/GitHub for tmux clients: node-tmux (unmaintained since 2019) and
tmux-js (no TypeScript types). Built a 100-line wrapper over execFile instead."
`;

export interface SessionConfigPaths {
  claudeMcp: string;
  opencode: string;
  /**
   * The OpenCode config as JSON, for OPENCODE_CONFIG_CONTENT: inline config has the highest
   * precedence, so a repo's (or an agent-written) opencode.json can't override model, permission or
   * the runner's MCP servers. It holds only {env:VAR} references, no secret values.
   */
  opencodeInline: string;
}

/**
 * Writes the session's Claude MCP config and OpenCode config into `configDir` (the runner's state
 * folder, outside every worktree, so no file the repo tracks is ever touched). Servers from a
 * `.mcp.json` the repo has in `cwd` are copied in, with the runner's servers taking precedence.
 */
export async function writeSessionConfig(
  fs: Fs,
  configDir: string,
  cwd: string,
  input: AgentConfigInput,
): Promise<SessionConfigPaths> {
  const ours = claudeMcpConfig(input);
  let repoServers: Record<string, unknown> = {};
  const repoMcp = join(cwd, REPO_MCP_FILE);
  if (await fs.exists(repoMcp)) {
    try {
      const parsed = JSON.parse(await fs.readFile(repoMcp)) as { mcpServers?: unknown };
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        repoServers = parsed.mcpServers as Record<string, unknown>;
      }
    } catch {
      // Unparseable repo file: use only the runner's servers.
    }
  }
  const opencode = opencodeConfig(input);
  const paths = {
    claudeMcp: join(configDir, CLAUDE_MCP_FILE),
    opencode: join(configDir, OPENCODE_CONFIG_FILE),
    opencodeInline: JSON.stringify(opencode),
  };
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  await fs.writeFile(paths.claudeMcp, json({ mcpServers: { ...repoServers, ...ours.mcpServers } }), {
    mode: 0o600,
  });
  await fs.writeFile(paths.opencode, json(opencode), { mode: 0o600 });
  return paths;
}
