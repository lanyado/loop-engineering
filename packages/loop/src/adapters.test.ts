// The CLI adapters (gh, claude, opencode) with a recording fake process runner: argv and parsing only.
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner, RunOptions, RunResult } from '@loop-engineering/runner';
import {
  buildJobCommand,
  CliAgentLauncher,
  claudeToolFlags,
  jobEnvironment,
  opencodeJobPermission,
} from './agent.js';
import { GhCli, GhDeployments, productionEnvironments, repoRef } from './gh.js';
import type { AgentJob } from './ports.js';
import { extractFencedJson, parseReview, QA_RIGHTS, REVIEW_RIGHTS, TEST_RIGHTS } from './prompts.js';

interface Call {
  bin: string;
  args: string[];
  options: RunOptions;
}

function fakeRun(respond: (call: Call) => Partial<RunResult>): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = (bin, args, options = {}) => {
    const call = { bin, args, options };
    calls.push(call);
    return Promise.resolve({ code: 0, stdout: '', stderr: '', ...respond(call) });
  };
  return { run, calls };
}

const REF = { slug: 'me/web', path: '/src/web' };
const GH_EMPTY = join(tmpdir(), 'loop-test-gh-empty');
const job = (over: Partial<AgentJob> = {}): AgentJob => ({
  kind: 'review',
  provider: 'claude',
  model: 'opus',
  cwd: '/jobs/pr1-review',
  prompt: 'Review this',
  systemPrompt: 'You are the reviewer',
  rights: REVIEW_RIGHTS,
  ...over,
});

describe('repoRef', () => {
  it('reads owner/name from ssh and https GitHub remotes', () => {
    const repo = { name: 'web', path: '/p', defaultBranch: 'main' };
    expect(repoRef({ ...repo, remote: 'git@github.com:me/web.git' }).slug).toBe('me/web');
    expect(repoRef({ ...repo, remote: 'https://github.com/me/web' }).slug).toBe('me/web');
    expect(repoRef({ ...repo, remote: '/tmp/remote.git' }).slug).toBe('/tmp/remote.git');
  });
});

describe('agent jobs', () => {
  it('runs claude -p with streamed JSON output, the system prompt, tool rights, and the prompt on stdin', () => {
    const cmd = buildJobCommand(job());
    expect(cmd.bin).toBe('claude');
    expect(cmd.input).toBe('Review this');
    expect(cmd.args.slice(0, 16)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'opus',
      '--permission-mode',
      'dontAsk',
      '--no-session-persistence',
      '--setting-sources',
      'user',
      '--settings',
      '{"disableAllHooks":true}',
      '--append-system-prompt',
      'You are the reviewer',
      '--strict-mcp-config',
    ]);
    // The reviewer reads files only: no shell (so no gh), no edits, no web.
    const allowed = cmd.args.slice(
      cmd.args.indexOf('--allowedTools') + 1,
      cmd.args.indexOf('--disallowedTools'),
    );
    expect(allowed).toEqual(['Read', 'Grep', 'Glob', 'LS']);
    const disallowed = cmd.args.slice(cmd.args.indexOf('--disallowedTools') + 1);
    expect(disallowed).toEqual(expect.arrayContaining(['Edit', 'Write', 'WebFetch', 'Bash']));
  });

  it('gives QA jobs the headless Playwright MCP, and testers edits and every command', () => {
    const qa = buildJobCommand(job({ kind: 'qa', rights: QA_RIGHTS }));
    const mcp = JSON.parse(qa.args[qa.args.indexOf('--mcp-config') + 1]!) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    expect(mcp.mcpServers.playwright?.args).toContain('--headless');
    expect(claudeToolFlags(QA_RIGHTS).allowed).toContain('mcp__playwright');
    expect(claudeToolFlags(TEST_RIGHTS).allowed).toEqual(expect.arrayContaining(['Bash', 'Edit']));
    expect(claudeToolFlags({ edit: false, bash: [], playwright: false, web: false }).disallowed).toContain(
      'Bash',
    );
  });

  it('runs opencode with the same rights as an inline config, and the system prompt in the message', () => {
    const cmd = buildJobCommand(job({ provider: 'opencode', model: 'opencode/glm-5.3-flash-free' }));
    expect(cmd.bin).toBe('opencode');
    expect(cmd.args).toEqual([
      'run',
      '--standalone',
      '--format',
      'json',
      '-m',
      'opencode/glm-5.3-flash-free',
      '--',
      'You are the reviewer\n\nReview this',
    ]);
    const config = JSON.parse(cmd.env.OPENCODE_CONFIG_CONTENT!) as {
      permission: Record<string, unknown>;
      mcp?: unknown;
    };
    expect(config.permission).toMatchObject({
      '*': 'deny',
      edit: 'deny',
      webfetch: 'deny',
      bash: { '*': 'deny' },
    });
    expect(Object.keys(config.permission.bash as object)).toEqual(['*']);
    expect(config.mcp).toBeUndefined();
    expect(Object.values(opencodeJobPermission(TEST_RIGHTS))).not.toContain('ask');
    expect(opencodeJobPermission(QA_RIGHTS)).toMatchObject({
      bash: { '*': 'allow', gh: 'deny' },
      edit: 'deny',
      'playwright_*': 'allow',
    });
  });

  it('the launcher passes cwd, stdin and the abort signal, and flags a non-zero exit', async () => {
    const { run, calls } = fakeRun(() => ({
      code: 1,
      stdout: JSON.stringify({ result: 'x', is_error: false }),
    }));
    const launcher = new CliAgentLauncher({ run, sourceEnv: { PATH: '/fake/bin' }, ghConfigDir: GH_EMPTY });
    const signal = new AbortController().signal;
    const result = await launcher.run(job(), signal);
    expect(result.isError).toBe(true);
    expect(calls[0]?.options).toMatchObject({
      cwd: '/jobs/pr1-review',
      input: 'Review this',
      cleanEnv: true,
      signal,
    });
  });

  it('jobs get a scrubbed environment: no server secrets, gh and git without credentials (B5)', async () => {
    const { run, calls } = fakeRun(() => ({ stdout: JSON.stringify({ result: 'x' }) }));
    const server = {
      PATH: '/usr/bin',
      HOME: '/Users/me',
      LANG: 'en_US.UTF-8',
      DASHBOARD_TOKEN: 'd',
      MCP_TOKEN: 'm',
      TELEGRAM_BOT_TOKEN: 't',
      GH_TOKEN: 'g',
      GITHUB_TOKEN: 'g2',
      GITHUB_PERSONAL_ACCESS_TOKEN: 'p',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      AWS_SECRET_ACCESS_KEY: 'a',
      ANTHROPIC_API_KEY: 'sk-ant',
    };
    await new CliAgentLauncher({ run, sourceEnv: server, ghConfigDir: GH_EMPTY }).run(
      job(),
      new AbortController().signal,
    );
    expect(calls[0]?.options.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      LANG: 'en_US.UTF-8',
      ANTHROPIC_API_KEY: 'sk-ant',
      GH_CONFIG_DIR: GH_EMPTY,
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_SSH_COMMAND: 'false',
    });
    expect(jobEnvironment({ MCP_TOKEN: 'm' }, GH_EMPTY)).not.toHaveProperty('MCP_TOKEN');
  });

  it("ignores the checkout's project settings and hooks (B5)", () => {
    const args = buildJobCommand(job()).args;
    expect(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2)).toEqual([
      '--setting-sources',
      'user',
    ]);
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({ disableAllHooks: true });
  });

  it('testers and QA keep a shell but never gh, git push or deploy tools (B5)', () => {
    const { disallowed } = claudeToolFlags(TEST_RIGHTS);
    expect(disallowed).toEqual(
      expect.arrayContaining(['Bash(gh:*)', 'Bash(git push:*)', 'Bash(vercel:*)', 'Bash(npx vercel:*)']),
    );
    expect(opencodeJobPermission(QA_RIGHTS).bash).toMatchObject({
      '*': 'allow',
      gh: 'deny',
      'gh *': 'deny',
      'git push *': 'deny',
    });
    expect(Object.keys(opencodeJobPermission(TEST_RIGHTS).bash as object)[0]).toBe('*'); // the catch-all first, denials win
  });
});

describe('GhCli', () => {
  const raw = {
    number: 7,
    url: 'https://github.com/me/web/pull/7',
    title: 't',
    body: 'b',
    state: 'OPEN',
    headRefName: 'loop/x',
    headRefOid: 'abc',
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    mergeCommit: null,
  };

  it('pings GitHub with one cheap call that rejects with the network error', async () => {
    const ok = fakeRun(() => ({ stdout: '{}' }));
    await new GhCli({ run: ok.run }).ping();
    expect(ok.calls[0]?.args).toEqual(['api', 'rate_limit']);
    const down = fakeRun(() => ({ code: 1, stderr: 'error connecting to api.github.com' }));
    await expect(new GhCli({ run: down.run }).ping()).rejects.toThrow(/error connecting to api.github.com/);
  });

  it('finds the PR on a branch, preferring an open one', async () => {
    const { run, calls } = fakeRun(() => ({
      stdout: JSON.stringify([{ ...raw, number: 9, state: 'CLOSED' }, raw]),
    }));
    const pr = await new GhCli({ run }).findPrForBranch(REF, 'loop/x');
    expect(pr).toMatchObject({ number: 7, state: 'OPEN', mergeCommitSha: null });
    expect(calls[0]?.args).toEqual([
      'pr',
      'list',
      '--head',
      'loop/x',
      '--state',
      'all',
      '--limit',
      '10',
      '--json',
      expect.any(String),
      '-R',
      'me/web',
    ]);
    expect(calls[0]?.options.cwd).toBe('/src/web');
  });

  it('reads isCrossRepository, and treats a missing value as a fork', async () => {
    const fork = fakeRun(() => ({ stdout: JSON.stringify({ ...raw, isCrossRepository: true }) }));
    expect((await new GhCli({ run: fork.run }).getPr(REF, 7)).isCrossRepository).toBe(true);
    const same = fakeRun(() => ({ stdout: JSON.stringify({ ...raw, isCrossRepository: false }) }));
    expect((await new GhCli({ run: same.run }).getPr(REF, 7)).isCrossRepository).toBe(false);
    const missing = fakeRun(() => ({ stdout: JSON.stringify(raw) }));
    expect((await new GhCli({ run: missing.run }).getPr(REF, 7)).isCrossRepository).toBe(true);
  });

  it('merges squash only at the expected head, and comments from stdin', async () => {
    const { run, calls } = fakeRun(() => ({}));
    const gh = new GhCli({ run });
    await gh.mergeSquash(REF, 7, 'abc');
    await gh.postComment(REF, 7, 'hello `world`');
    expect(calls[0]?.args).toEqual([
      'pr',
      'merge',
      '7',
      '--squash',
      '--match-head-commit',
      'abc',
      '-R',
      'me/web',
    ]);
    expect(calls[1]).toMatchObject({
      args: ['pr', 'comment', '7', '--body-file', '-', '-R', 'me/web'],
      options: { input: 'hello `world`' },
    });
  });

  it('reads checks even when gh exits non-zero for pending or failing ones', async () => {
    const { run } = fakeRun(() => ({ code: 8, stdout: JSON.stringify([{ name: 'ci', bucket: 'pending' }]) }));
    expect(await new GhCli({ run }).checks(REF, 7)).toEqual([
      { name: 'ci', bucket: 'pending', link: undefined },
    ]);
    const none = fakeRun(() => ({ code: 1, stderr: 'no checks reported on the branch' }));
    expect(await new GhCli({ run: none.run }).checks(REF, 7)).toEqual([]);
  });

  it('opens a revert PR with gh pr revert and returns the number it printed', async () => {
    const { run, calls } = fakeRun((c) =>
      c.args[1] === 'revert'
        ? { stdout: 'https://github.com/me/web/pull/8\n' }
        : { stdout: JSON.stringify({ ...raw, number: 8 }) },
    );
    const gh = new GhCli({ run });
    expect((await gh.createRevertPr(REF, 7, { title: 'Revert', body: 'b' })).number).toBe(8);
    expect(calls[0]?.args).toEqual(['pr', 'revert', '7', '--title', 'Revert', '--body', 'b', '-R', 'me/web']);
  });

  it('merges conversation, review and inline comments in time order', async () => {
    const { run } = fakeRun((c) =>
      c.args[0] === 'api'
        ? {
            stdout: JSON.stringify([
              { user: { login: 'r' }, body: '[blocking] x', created_at: '2026-01-02', path: 'a.ts', line: 3 },
            ]),
          }
        : {
            stdout: JSON.stringify({
              comments: [{ author: { login: 'a' }, body: 'c1', createdAt: '2026-01-03' }],
              reviews: [{ author: { login: 'b' }, body: '', submittedAt: '2026-01-01' }],
            }),
          },
    );
    expect((await new GhCli({ run }).listComments(REF, 7)).map((c) => c.body)).toEqual([
      '[blocking] x',
      'c1',
    ]);
  });
});

describe('GhDeployments', () => {
  function deployments(list: unknown[], statuses: Record<string, unknown[]>) {
    return fakeRun((c) => {
      const path = c.args[1] ?? '';
      const match = /deployments\/(\d+)\/statuses/.exec(path);
      return { stdout: JSON.stringify(match ? (statuses[match[1]!] ?? []) : list) };
    });
  }

  it("reads the newest deployment of the project's production environment only (exact name)", async () => {
    const { run, calls } = deployments(
      [
        { id: 4, environment: 'Production – web-admin' },
        { id: 3, environment: 'Production – web' },
        { id: 2, environment: 'Production - web' },
        { id: 1, environment: 'Preview – web' },
      ],
      {
        '4': [{ state: 'failure' }],
        '3': [{ state: 'success', environment_url: 'https://web.vercel.app' }],
        '2': [{ state: 'failure' }],
        '1': [{ state: 'failure' }],
      },
    );
    expect(await new GhDeployments({ run }).status(REF, 'abc', 'web')).toMatchObject({
      state: 'success',
      url: 'https://web.vercel.app',
      environment: 'Production – web',
    });
    expect(calls[0]?.args).toEqual(['api', 'repos/me/web/deployments?sha=abc&per_page=30']);
    expect(productionEnvironments('web')).toEqual(['production - web', 'production']);
  });

  it("another project's failure on the same commit never counts", async () => {
    const { run } = deployments([{ id: 1, environment: 'Production – other' }], {
      '1': [{ state: 'failure' }],
    });
    expect((await new GhDeployments({ run }).status(REF, 'abc', 'web')).state).toBe('not_found');
  });

  it('treats inactive as superseded: success if it had succeeded, else the older deployment decides', async () => {
    const after = deployments([{ id: 2, environment: 'Production' }], {
      '2': [{ state: 'inactive' }, { state: 'success' }, { state: 'in_progress' }],
    });
    expect((await new GhDeployments({ run: after.run }).status(REF, 'abc', 'web')).state).toBe('success');
    const superseded = deployments(
      [
        { id: 2, environment: 'Production' },
        { id: 1, environment: 'Production' },
      ],
      { '2': [{ state: 'inactive' }], '1': [{ state: 'error', description: 'boom' }] },
    );
    expect(await new GhDeployments({ run: superseded.run }).status(REF, 'abc', 'web')).toMatchObject({
      state: 'failure',
      description: 'boom',
    });
  });

  it('reports failures with their description and logs, pending, and not_found', async () => {
    const failed = deployments([{ id: 1, environment: 'Production' }], {
      '1': [{ state: 'error', description: 'Build failed', log_url: 'https://vercel.com/logs' }],
    });
    expect(await new GhDeployments({ run: failed.run }).status(REF, 'abc', 'web')).toMatchObject({
      state: 'failure',
      description: 'Build failed',
      logUrl: 'https://vercel.com/logs',
    });
    const pending = deployments([{ id: 1, environment: 'Production' }], { '1': [{ state: 'in_progress' }] });
    expect((await new GhDeployments({ run: pending.run }).status(REF, 'abc', 'web')).state).toBe('pending');
    const none = deployments([], {});
    expect((await new GhDeployments({ run: none.run }).status(REF, 'abc', 'web')).state).toBe('not_found');
  });
});

describe('verdicts', () => {
  it('takes only the last ```json block, with no fallback (B4)', () => {
    expect(extractFencedJson('a ```json\n{"x":1}\n``` b ```json\n{"x":2}\n```')).toEqual({ x: 2 });
    expect(extractFencedJson('Verdict: {"x": {"y": 3}} done')).toBeNull();
    expect(extractFencedJson('```json\n{"x":1}\n``` then ```json\nnot json\n```')).toBeNull();
    expect(extractFencedJson('nothing here')).toBeNull();
    const fence = (o: unknown) => '```json\n' + JSON.stringify(o) + '\n```';
    expect(parseReview('Looks wrong.\n\n' + fence({ verdict: 'changes', blocking: ['a'] }))).toEqual({
      verdict: 'changes',
      blocking: ['a'],
      report: 'Looks wrong.\n\n- [blocking] a',
    });
    expect(parseReview(fence({ blocking: ['a'] }))).toBeNull();
    expect(parseReview(fence({ verdict: 'approve', blocking: ['a'] }))?.verdict).toBe('changes');
    expect(parseReview('Fine.\n' + fence({ verdict: 'approve', security: [] }))).toEqual({
      verdict: 'approve',
      blocking: [],
      report: 'Fine.',
    });
  });
});
