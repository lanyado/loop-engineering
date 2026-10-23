import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';

/** A CLI the system calls; `need` is what it is for, `install` how to get it. */
interface Tool {
  name: string;
  required: boolean;
  need: string;
  install: string;
}

export const TOOLS: Tool[] = [
  { name: 'git', required: true, need: 'worktrees and commits', install: 'xcode-select --install' },
  { name: 'tmux', required: true, need: 'runs each session', install: 'brew install tmux' },
  {
    name: 'claude',
    required: true,
    need: 'the coding agent',
    install: 'npm install -g @anthropic-ai/claude-code, then run `claude` once to log in',
  },
  {
    name: 'gh',
    required: false,
    need: 'the PR loop (LOOP_ENGINE=on)',
    install: 'brew install gh && gh auth login',
  },
  {
    name: 'opencode',
    required: false,
    need: 'free-model fallback when Claude hits its limit',
    install: 'see https://opencode.ai',
  },
  {
    name: 'jq',
    required: false,
    need: 'the usage meters (scripts/capture-claude-usage.sh)',
    install: 'brew install jq',
  },
];

const MIN_NODE = [20, 19] as const;

export interface SetupIo {
  /** The repository root, holding .env.example. */
  root: string;
  home: string;
  nodeVersion: string;
  /** Whether a command is on PATH. */
  onPath: (command: string) => boolean;
  /** A fresh bearer token (characters the server accepts). */
  randomToken: () => string;
  out: (line: string) => void;
}

/**
 * Sets `KEY=value` for each key that is unset or empty as Node reads the file (`export KEY=`,
 * `KEY = ""`, a later empty duplicate). Values already set are kept, so running setup again never
 * replaces a token or a folder you chose. The key's last line is the one rewritten, since it is the
 * one Node uses.
 */
export function fillEnv(text: string, values: Record<string, string>): { text: string; filled: string[] } {
  const filled: string[] = [];
  let out = text;
  for (const [key, value] of Object.entries(values)) {
    if (parseEnv(out)[key]?.trim()) continue;
    const lines = [...out.matchAll(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=.*$`, 'gm'))];
    const last = lines.at(-1);
    out = last
      ? `${out.slice(0, last.index)}${key}=${value}${out.slice(last.index + last[0].length)}`
      : `${out.replace(/\n*$/, '\n')}${key}=${value}\n`;
    filled.push(key);
  }
  return { text: out, filled };
}

function nodeTooOld(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]);
}

/** `npm run setup`: checks the tools and writes .env. Returns the exit code (1 if a required tool is missing). */
export function runSetup(io: SetupIo): number {
  if (nodeTooOld(io.nodeVersion)) {
    io.out(`✗ Node ${io.nodeVersion} is too old: install Node ${MIN_NODE.join('.')} or newer.`);
    return 1;
  }
  io.out(`✓ node ${io.nodeVersion}`);
  const missing: string[] = [];
  for (const tool of TOOLS) {
    if (io.onPath(tool.name)) io.out(`✓ ${tool.name}`);
    else {
      io.out(`${tool.required ? '✗' : '–'} ${tool.name} not found (${tool.need}): ${tool.install}`);
      if (tool.required) missing.push(tool.name);
    }
  }

  const envPath = join(io.root, '.env');
  const created = !existsSync(envPath);
  const before = created
    ? readFileSync(join(io.root, '.env.example'), 'utf8')
    : readFileSync(envPath, 'utf8');
  const worktrees = join(io.home, 'loop-worktrees');
  const { text, filled } = fillEnv(before, {
    DASHBOARD_TOKEN: io.randomToken(),
    MCP_TOKEN: io.randomToken(),
    WORKTREES_ROOT: worktrees,
  });
  if (created || filled.length > 0) writeFileSync(envPath, text);
  // writeFileSync's mode only applies to a new file; a .env copied by hand is often 0644.
  chmodSync(envPath, 0o600);
  io.out(
    created
      ? `✓ created .env (${filled.join(', ')} filled in)`
      : filled.length > 0
        ? `✓ .env: filled in ${filled.join(', ')}`
        : '✓ .env already set up (nothing changed)',
  );
  const root = /^WORKTREES_ROOT=(.*)$/m.exec(text)?.[1]?.trim() ?? worktrees;
  // The server refuses a relative WORKTREES_ROOT at start, with its own message.
  if (isAbsolute(root)) mkdirSync(root, { recursive: true });

  io.out('');
  if (missing.length > 0) {
    io.out(`Install ${missing.join(', ')}, then run \`npm run setup\` again.`);
    return 1;
  }
  const port = /^DASHBOARD_PORT=(.*)$/m.exec(text)?.[1]?.trim() || '3737';
  io.out('Ready. Next:');
  io.out(`  1. npm start  (server + dashboard at http://127.0.0.1:${port})`);
  io.out('  2. npm run add-project -- /path/to/your/repo  (in a second terminal)');
  io.out(
    `  3. Once, so sessions can start: run \`claude\` in ${root} and in each project folder, and accept "Yes, I trust this folder"`,
  );
  return 0;
}
