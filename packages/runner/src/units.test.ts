import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SESSION_HEADER } from '@loop-engineering/ask-human';
import { PERMISSION_MODES } from '@loop-engineering/core';
import { describe, expect, it } from 'vitest';
import { DefaultAgentCli } from './agent-cli.js';
import {
  claudeMcpConfig,
  DEFAULT_MCP_TOKEN_ENV,
  OPENCODE_PERMISSION_KEYS,
  opencodeConfig,
  opencodePermission,
  type OpencodeRule,
} from './agent-config.js';
import { buildContinuationPrompt } from './continuation.js';
import { renderLaunchScript, shellQuote } from './launch.js';
import { detectUsageLimit } from './usage-limit.js';

describe('detectUsageLimit', () => {
  it.each([
    ['Claude AI usage limit reached|1760792400', 'Claude AI usage limit reached|1760792400'],
    [
      '  ⎿  Claude usage limit reached. Your limit will reset at 5pm (Europe/London).',
      'Claude usage limit reached. Your limit will reset at 5pm (Europe/London).',
    ],
    ["│ You've hit your limit · resets 3pm │", "You've hit your limit · resets 3pm"],
    ['You’ve reached your weekly limit', 'You’ve reached your weekly limit'],
    ['⎿ 5-hour limit reached ∙ resets 2am', '5-hour limit reached ∙ resets 2am'],
    ["You're out of extra usage · resets Oct 20", "You're out of extra usage · resets Oct 20"],
  ])('detects %j', (line, cleaned) => {
    expect(detectUsageLimit(`some output\n${line}\n> `)).toBe(cleaned);
  });

  it.each([
    'Added a rate limit to the API',
    'The usage page shows the limit for each plan',
    'Opus limit reached ∙ now using Sonnet',
    // Agent output quoting the messages mid-line (code, diffs, test logs) is not a match.
    "expect(detectUsageLimit(x)).toBe('Claude AI usage limit reached|1');",
    '+  /^Claude AI usage limit reached\\|\\d+$/i,',
    '// matches "5-hour limit reached ∙ resets 2am"',
    'The CLI prints "Claude usage limit reached" when the plan runs out',
    'grep: usage limit reached in 3 files',
  ])('ignores %j', (line) => {
    expect(detectUsageLimit(`${line}\n`)).toBeNull();
  });

  it('only looks at the bottom of the pane', () => {
    const old = ['Claude AI usage limit reached|1', ...Array.from({ length: 30 }, (_, i) => `line ${i}`)];
    expect(detectUsageLimit(old.join('\n'))).toBeNull();
    expect(detectUsageLimit(old.join('\n'), undefined, 40)).toBe('Claude AI usage limit reached|1');
  });
});

describe('DefaultAgentCli', () => {
  const cli = new DefaultAgentCli({ claude: '/bin/fake-claude', opencode: '/bin/fake-opencode' });

  it('refuses a model name a CLI would read as an option, and passes a good one as one argument', () => {
    for (const model of ['--dangerously-skip-permissions', '-p', '', 'opus --effort max', 'opus\n--x'])
      expect(() => cli.build({ provider: 'claude', model, permissionMode: 'auto' })).toThrow(/refusing/);
    const argv = cli.build({ provider: 'claude', model: 'claude-opus-4-8', permissionMode: 'auto' });
    expect(argv.slice(1, 3)).toEqual(['--model', 'claude-opus-4-8']);
  });

  it('builds a new and a resumed Claude session', () => {
    expect(
      cli.build({
        provider: 'claude',
        model: 'opus',
        permissionMode: 'auto',
        agentSessionId: 'id-1',
        mcpConfigPath: '/state/s1/mcp.json',
        systemPrompt: 'note',
        prompt: '--not-a-flag',
      }),
    ).toEqual([
      '/bin/fake-claude',
      '--session-id',
      'id-1',
      '--model',
      'opus',
      '--permission-mode',
      'auto',
      '--mcp-config',
      '/state/s1/mcp.json',
      '--strict-mcp-config',
      '--append-system-prompt',
      'note',
      '--',
      '--not-a-flag',
    ]);
    expect(
      cli.build({
        provider: 'claude',
        model: 'opus',
        permissionMode: 'plan',
        agentSessionId: 'id-1',
        resume: true,
        effort: 'max',
      }),
    ).toEqual([
      '/bin/fake-claude',
      '--resume',
      'id-1',
      '--model',
      'opus',
      '--permission-mode',
      'plan',
      '--effort',
      'max',
    ]);
    expect(() =>
      cli.build({ provider: 'claude', model: 'opus', permissionMode: 'manual', resume: true }),
    ).toThrow();
  });

  it('always runs OpenCode on a private server, auto-approving only in bypass mode', () => {
    for (const mode of PERMISSION_MODES) {
      const argv = cli.build({
        provider: 'opencode',
        model: 'm',
        permissionMode: mode,
        prompt: 'go on',
        systemPrompt: 'note',
      });
      expect(argv.slice(0, 2)).toEqual(['/bin/fake-opencode', '--standalone']);
      expect(argv.includes('--auto')).toBe(mode === 'bypassPermissions' || mode === 'auto');
      expect(argv.at(-1)).toBe('--prompt=note\n\ngo on');
    }
    expect(cli.build({ provider: 'opencode', model: 'm', permissionMode: 'manual', resume: true })).toEqual([
      '/bin/fake-opencode',
      '--standalone',
      '--continue',
    ]);
  });
});

/** OpenCode's rule resolution: the last matching wildcard wins; a per-pattern rule then matches the argument. */
function resolvePermission(rules: Record<string, OpencodeRule>, tool: string, arg = ''): string | undefined {
  const last = <T>(entries: [string, T][], subject: string): T | undefined => {
    let result: T | undefined;
    for (const [pattern, action] of entries) {
      const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      if (re.test(subject)) result = action;
    }
    return result;
  };
  const rule = last(Object.entries(rules), tool);
  return typeof rule === 'object' ? last(Object.entries(rule), arg) : rule;
}

describe('agent config', () => {
  const input = {
    serverUrl: 'https://loop.example.com',
    sessionId: 7,
    tokenEnv: 'MY_TOKEN',
    fallbackModel: 'opencode/free',
    permissionMode: 'auto' as const,
  };

  it('sends the session header and token the ask_human server checks', () => {
    const header = Object.keys(claudeMcpConfig(input).mcpServers.ask_human?.headers ?? {}).find((h) =>
      h.toLowerCase().startsWith('x-loop'),
    );
    expect(header).toBe(SESSION_HEADER);
    expect(claudeMcpConfig(input).mcpServers.ask_human?.headers?.[SESSION_HEADER]).toBe('7');
    expect(
      (opencodeConfig(input).mcp as Record<string, { headers: Record<string, string> }>).ask_human?.headers[
        SESSION_HEADER
      ],
    ).toBe('7');
    expect(DEFAULT_MCP_TOKEN_ENV).toBe('MCP_TOKEN');
  });

  it('gives Claude and OpenCode the same servers', () => {
    const claude = Object.keys(claudeMcpConfig(input).mcpServers).sort();
    const opencode = Object.keys(opencodeConfig(input).mcp as object).sort();
    expect(claude).toEqual(opencode);
    expect(claudeMcpConfig(input).mcpServers.ask_human?.headers?.Authorization).toBe('Bearer ${MY_TOKEN}');
  });

  it('starts every OpenCode mapping with a "*" catch-all that only bypass and auto allow, then sets every documented key', () => {
    for (const mode of PERMISSION_MODES) {
      const rules = opencodePermission(mode);
      expect(Object.keys(rules)[0]).toBe('*');
      expect(rules['*'] === 'allow').toBe(mode === 'bypassPermissions' || mode === 'auto');
      for (const key of OPENCODE_PERMISSION_KEYS) expect([mode, key, rules[key]]).not.toContain(undefined);
    }
  });

  it('auto mode never asks: work is allowed, risky calls are denied', () => {
    const rules = opencodePermission('auto');
    const allowed = [
      'bash',
      'ask_human_ask_human',
      'playwright_browser_navigate',
      'webfetch',
      'task',
      'edit',
    ];
    for (const tool of allowed) expect([tool, resolvePermission(rules, tool)]).toEqual([tool, 'allow']);
    expect(resolvePermission(rules, 'bash', 'git status')).toBe('allow');
    for (const command of [
      'git push --force origin main',
      'git reset --hard HEAD~1',
      'sudo rm x',
      'rm -rf /',
    ])
      expect([command, resolvePermission(rules, 'bash', command)]).toEqual([command, 'deny']);
    for (const tool of ['github_merge_pull_request', 'external_directory', 'question'])
      expect([tool, resolvePermission(rules, tool)]).toEqual([tool, 'deny']);
  });

  it('auto mode lets OpenCode reach the temp dir, and no other folder outside the worktree', () => {
    const rules = opencodePermission('auto');
    for (const dir of [tmpdir(), '/tmp'])
      expect([dir, resolvePermission(rules, 'external_directory', join(dir, 'opencode', '*'))]).toEqual([
        dir,
        'allow',
      ]);
    for (const dir of ['/Users/someone/other-repo', '/etc', '/'])
      expect([dir, resolvePermission(rules, 'external_directory', join(dir, '*'))]).toEqual([dir, 'deny']);
  });

  it.each(['manual', 'acceptEdits', 'plan'] as const)(
    '%s mode cannot run MCP tools, websearch, subagents or commands without asking',
    (mode) => {
      const rules = opencodePermission(mode);
      for (const tool of [
        'github_merge_pull_request',
        'github_push_files',
        'ask_human_ask_human',
        'playwright_browser_navigate',
        'websearch',
        'webfetch',
        'task',
        'skill',
        'bash',
        'question',
        'doom_loop',
        'external_directory',
        'some_tool_added_later',
      ]) {
        expect([tool, resolvePermission(rules, tool)]).toEqual([tool, 'ask']);
      }
      expect(resolvePermission(rules, 'read', 'src/app.ts')).toBe('allow');
    },
  );

  it('keeps OpenCode’s default deny on reading env files, in every mode', () => {
    for (const mode of PERMISSION_MODES) {
      const read = (path: string) => resolvePermission(opencodePermission(mode), 'read', path);
      expect([read('.env'), read('config/.env.local'), read('.env.example'), read('README.md')]).toEqual([
        'deny',
        'deny',
        'allow',
        'allow',
      ]);
    }
  });

  it('auto and acceptEdits allow edits; manual asks; plan and dontAsk deny', () => {
    const edit = (mode: (typeof PERMISSION_MODES)[number]) =>
      resolvePermission(opencodePermission(mode), 'edit');
    expect([edit('auto'), edit('acceptEdits'), edit('manual'), edit('plan'), edit('dontAsk')]).toEqual([
      'allow',
      'allow',
      'ask',
      'deny',
      'deny',
    ]);
    expect(resolvePermission(opencodePermission('dontAsk'), 'github_merge_pull_request')).toBe('deny');
    expect(resolvePermission(opencodePermission('bypassPermissions'), 'github_merge_pull_request')).toBe(
      'allow',
    );
  });
});

describe('launch script', () => {
  it('quotes anything', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(() => renderLaunchScript(['x'], { 'BAD-NAME': '1' }, '/')).toThrow(/invalid environment/);
  });

  it('runs the exact argv with the env under /bin/sh and deletes itself', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-launch-'));
    try {
      const tricky = `line one\nit's "quoted" $HOME \`x\` \\ end`;
      const script = renderLaunchScript(
        ['/bin/sh', '-c', 'printf "%s|%s|%s" "$PWD" "$GREETING" "$1"', 'sh', tricky],
        { GREETING: "hi 'there'" },
        dir,
      );
      const path = join(dir, 'launch.sh');
      await writeFile(path, script);
      const { stdout } = await promisify(execFile)('sh', [path]);
      const [pwd, greeting, arg] = stdout.split('|');
      expect(pwd?.endsWith(dir.split('/').pop() ?? '')).toBe(true);
      expect(greeting).toBe("hi 'there'");
      expect(arg).toBe(tricky);
      await expect(promisify(execFile)('test', ['-e', path])).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('buildContinuationPrompt', () => {
  it('lists the request, branch, changes and commits per repo', () => {
    const prompt = buildContinuationPrompt({
      requests: ['Do X'],
      branch: 'loop/x',
      reason: 'limit',
      repos: [
        {
          repo: 'web',
          path: '/w',
          status: ' M a.ts',
          diffStat: ' 1 file changed',
          recentCommits: ['abc fix'],
        },
        { repo: 'api', path: '/a', status: '', diffStat: '', recentCommits: [] },
      ],
    });
    expect(prompt).toContain('## Original request\n\nDo X');
    expect(prompt).toContain('loop/x');
    expect(prompt).toMatch(/## Repo web \(\/w\)[\s\S]*M a\.ts[\s\S]*1 file changed[\s\S]*abc fix/);
    expect(prompt).toMatch(/## Repo api \(\/a\)\n\n### Uncommitted changes\n\n\(none\)/);
  });

  it('caps long status output', () => {
    const status = Array.from({ length: 100 }, (_, i) => `?? f${i}`).join('\n');
    const prompt = buildContinuationPrompt({
      requests: [],
      branch: 'b',
      reason: 'r',
      repos: [{ repo: 'w', path: '/w', status, diffStat: '', recentCommits: [] }],
    });
    expect(prompt).toContain('… (40 more lines)');
    expect(prompt).toContain('(not recorded)');
  });
});
