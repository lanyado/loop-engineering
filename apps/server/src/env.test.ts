import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fromRoot, loadRootEnv, REPO_ROOT, rootEnvNames } from './env.js';
import { checkAgentEnvExtra, gitVersionWarning, hiddenTmuxEnv } from './runner.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.LOOP_ENV_TEST_A;
  delete process.env.LOOP_ENV_TEST_B;
});

describe('env', () => {
  it('finds the repo root from the module location, not the working directory', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { name: string };
    expect(pkg.name).toBe('loop-engineering');
  });

  it('loads <root>/.env without overriding variables already set', () => {
    const root = mkdtempSync(join(tmpdir(), 'loop-env-'));
    dirs.push(root);
    expect(loadRootEnv(root)).toBe(false);
    writeFileSync(join(root, '.env'), 'LOOP_ENV_TEST_A=from-file\nLOOP_ENV_TEST_B=from-file\n');
    process.env.LOOP_ENV_TEST_B = 'from-shell';
    expect(loadRootEnv(root)).toBe(true);
    expect(process.env.LOOP_ENV_TEST_A).toBe('from-file');
    expect(process.env.LOOP_ENV_TEST_B).toBe('from-shell');
  });

  it("lists the names .env sets, so the runner keeps them out of tmux's global environment", () => {
    const root = mkdtempSync(join(tmpdir(), 'loop-env-'));
    dirs.push(root);
    expect(rootEnvNames(root)).toEqual([]);
    writeFileSync(join(root, '.env'), '# comment\nDASHBOARD_TOKEN=abc\nEMAIL_APP_PASSWORD="x y"\nEMPTY=\n');
    expect(rootEnvNames(root)).toEqual(['DASHBOARD_TOKEN', 'EMAIL_APP_PASSWORD', 'EMPTY']);
    // The runner hides the server's secrets and .env's names, except what agents and tmux get anyway.
    expect(
      hiddenTmuxEnv(['EMAIL_APP_PASSWORD', 'PATH', 'LANG', 'LC_ALL', 'TAVILY_API_KEY', 'GH_TOKEN']),
    ).toEqual([
      'DASHBOARD_TOKEN',
      'DASHBOARD_PASSWORD',
      'DASHBOARD_SESSION_SECRET',
      'MCP_TOKEN',
      'EMAIL_APP_PASSWORD',
      'TAVILY_API_KEY',
    ]);
  });

  it('refuses an AGENT_ENV_EXTRA that would give agents a server secret, and stops the start', () => {
    expect(checkAgentEnvExtra({ AGENT_ENV_EXTRA: ' AWS_* , OPENROUTER_API_KEY,' })).toEqual([
      'AWS_*',
      'OPENROUTER_API_KEY',
    ]);
    expect(checkAgentEnvExtra({})).toEqual([]);
    for (const bad of [
      'DASHBOARD_TOKEN',
      'DASH*',
      'MCP_*',
      'EMAIL_*',
      'EM*',
      'EMAIL_APP_PASSWORD',
      'A-B',
      '*',
      'A*B',
    ])
      expect(() => checkAgentEnvExtra({ AGENT_ENV_EXTRA: bad })).toThrow(/AGENT_ENV_EXTRA/);
  });

  it("warns when git is too old for the runner's config guard (GIT_CONFIG_COUNT, git 2.31)", () => {
    expect(gitVersionWarning('git version 2.30.9\n')).toMatch(/git 2\.30\.9 is older than 2\.31/);
    expect(gitVersionWarning('git version 1.9.0')).toMatch(
      /git 1\.9\.0 is older than 2\.26.*no session can start/,
    );
    expect(gitVersionWarning('git version 2.25.1')).toMatch(
      /git 2\.25\.1 is older than 2\.26.*no session can start/,
    );
    expect(gitVersionWarning('git version 2.26.0')).toMatch(/git 2\.26\.0 is older than 2\.31/);
    expect(gitVersionWarning('git version 2.31.0')).toBeNull();
    expect(gitVersionWarning('git version 2.47.3 (Apple Git-154)')).toBeNull();
    expect(gitVersionWarning('git version 3.0.0')).toBeNull();
    expect(gitVersionWarning(null)).toBeNull();
  });

  it('resolves relative paths against the root', () => {
    expect(fromRoot('./data/loop.db', '/srv/loop')).toBe('/srv/loop/data/loop.db');
    expect(fromRoot('/var/loop.db', '/srv/loop')).toBe('/var/loop.db');
    expect(fromRoot(':memory:', '/srv/loop')).toBe(':memory:');
  });
});
