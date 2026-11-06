import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfigList, RealGitDriver, repoConfigGuard } from './git.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();

describe('RealGitDriver fetch + addWorktree (local bare origin)', () => {
  let dir: string;
  let origin: string;
  let clone: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loop-git-'));
    origin = join(dir, 'origin.git');
    clone = join(dir, 'clone');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, clone]);
    git(clone, 'commit', '-q', '--allow-empty', '-m', 'first');
    git(clone, 'push', '-q', '-u', 'origin', 'main');
    // A second checkout pushes a commit the first one has not seen.
    const other = join(dir, 'other');
    execFileSync('git', ['clone', '-q', origin, other]);
    execFileSync('sh', ['-c', 'echo only-on-origin > only-origin.txt'], { cwd: other });
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'only on origin');
    git(other, 'push', '-q', 'origin', 'main');
  });

  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('starts a new worktree from origin tip without tracking it', async () => {
    const driver = new RealGitDriver();
    const wt = join(dir, 'wt');
    await driver.fetch(clone, 'main');
    await driver.addWorktree(clone, wt, 'loop/x', 'origin/main');
    expect(await readFile(join(wt, 'only-origin.txt'), 'utf8')).toBe('only-on-origin\n');
    expect(git(wt, 'log', '-1', '--format=%s')).toBe('only on origin');
    expect(git(clone, 'log', '-1', '--format=%s', 'main')).toBe('first');
    expect(() => git(wt, 'rev-parse', '--abbrev-ref', 'loop/x@{upstream}')).toThrow();
  });

  it('rejects when the remote cannot be fetched', async () => {
    const lone = join(dir, 'lone');
    execFileSync('git', ['init', '-q', lone]);
    await expect(new RealGitDriver().fetch(lone, 'main')).rejects.toThrow();
  });
});

describe("RealGitDriver never runs a repo's own hooks, fsmonitor or filters, nor gives git the server's secrets", () => {
  let dir: string;
  let origin: string;
  let repo: string;
  let wt: string;
  let canary: string;
  let envDump: string;
  let driver: RealGitDriver;
  const fired = () => readdirSync(canary).sort();

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'loop-git-safe-')));
    canary = join(dir, 'canary');
    mkdirSync(canary);
    envDump = join(dir, 'git-env.txt');
    origin = join(dir, 'origin.git');
    repo = join(dir, 'repo');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, repo]);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    writeFileSync(join(repo, '.gitattributes'), '* filter=evil diff=evil\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    // What a builder could plant in the .git its worktree shares: every one would run as the user.
    const touch = (name: string) => `touch '${join(canary, name)}'`;
    git(repo, 'config', 'core.fsmonitor', touch('fsmonitor'));
    git(repo, 'config', 'filter.evil.clean', `${touch('filter-clean')}; cat`);
    git(repo, 'config', 'filter.evil.smudge', `${touch('filter-smudge')}; cat`);
    git(repo, 'config', 'filter.evil.required', 'true');
    git(repo, 'config', 'diff.evil.textconv', `${touch('textconv')}; cat`);
    git(repo, 'config', 'credential.helper', `!${touch('credential')}`);
    git(repo, 'config', 'core.pager', touch('pager'));
    for (const hook of ['pre-push', 'post-checkout', 'reference-transaction', 'pre-commit']) {
      writeFileSync(join(repo, '.git/hooks', hook), `#!/bin/sh\n${touch(hook)}\n`, { mode: 0o755 });
    }
    // The server's environment, and a git that saves the environment it was given.
    const wrapper = join(dir, 'git-wrapper.sh');
    writeFileSync(wrapper, `#!/bin/sh\n/usr/bin/env >> '${envDump}'\nexec git "$@"\n`, { mode: 0o755 });
    driver = new RealGitDriver({
      bin: wrapper,
      sourceEnv: {
        ...process.env,
        DASHBOARD_TOKEN: 'leak-dashboard',
        MCP_TOKEN: 'leak-mcp',
        EMAIL_APP_PASSWORD: 'leak-email',
        SSH_AUTH_SOCK: '/srv/loop/agent.sock',
      },
    });
    wt = join(dir, 'wt');
  });

  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('adds a worktree, reads status, diff and log, and pushes, with nothing planted firing', async () => {
    await driver.fetch(repo, 'main');
    await driver.addWorktree(repo, wt, 'loop/safe', 'origin/main');
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    expect(await driver.status(wt)).toBe(' M a.txt');
    expect(await driver.diffStat(wt)).toMatch(/a\.txt \| 2 \+-/);
    const quiet = [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'filter.evil.clean=cat',
    ];
    git(wt, ...quiet, 'commit', '-qam', 'second');
    expect(await driver.recentCommits(wt, 1)).toEqual([expect.stringMatching(/ second$/)]);
    expect(await driver.commitsAhead(wt, 'origin/main')).toBe(1);
    await driver.push(wt, 'loop/safe');
    expect(git(origin, 'log', '-1', '--format=%s', 'loop/safe')).toBe('second');
    await driver.removeWorktree(repo, wt, { force: true });
    await driver.deleteBranch(repo, 'loop/safe');
    expect(fired()).toEqual([]);
  });

  it('gives git only its allowlist: the SSH agent and the toolchain, no server secret', async () => {
    const dump = await readFile(envDump, 'utf8');
    expect(dump).not.toContain('leak-');
    expect(dump).toContain('SSH_AUTH_SOCK=/srv/loop/agent.sock');
    expect(dump).toContain('GIT_TERMINAL_PROMPT=0');
  });

  it("puts back the user's own credential helper and ssh command over the repo's", () => {
    const entries = [
      { scope: 'global', key: 'credential.helper', value: '!gh auth git-credential' },
      { scope: 'local', key: 'credential.helper', value: '!evil' },
      { scope: 'local', key: 'core.sshcommand', value: 'evil' },
      { scope: 'local', key: 'filter.LFS.clean', value: 'evil' },
      { scope: 'local', key: 'user.name', value: 'me' },
    ];
    expect(repoConfigGuard(entries)).toEqual([
      '-c',
      'credential.helper=',
      '-c',
      'credential.helper=!gh auth git-credential',
      '-c',
      'core.sshcommand=',
      '-c',
      'core.sshcommand=ssh',
      '-c',
      'filter.LFS.clean=',
      '-c',
      'filter.LFS.required=false',
    ]);
    expect(parseConfigList('local\0core.bare\nfalse\0local\0x.flag\0')).toEqual([
      { scope: 'local', key: 'core.bare', value: 'false' },
      { scope: 'local', key: 'x.flag', value: 'true' },
    ]);
  });
});
