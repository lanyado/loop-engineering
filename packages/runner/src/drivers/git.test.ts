import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitConfigEnv, parseConfigList, RealGitDriver, repoConfigGuard } from './git.js';
import { gitEnvironment } from '../agent-env.js';

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
    writeFileSync(join(repo, 'b.eq'), 'one\n');
    // Driver names with "=" in them, which no `-c key=value` can name.
    writeFileSync(
      join(repo, '.gitattributes'),
      '* filter=evil diff=evil\n*.eq filter=x=y diff=a=b merge=a=b\n',
    );
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
    appendFileSync(
      join(repo, '.git/config'),
      `[filter "x=y"]\n\tclean = ${touch('eq-clean')}; cat\n\tsmudge = ${touch('eq-smudge')}; cat\n\trequired = true\n` +
        `[diff "a=b"]\n\ttextconv = ${touch('eq-textconv')}; cat\n\tcommand = ${touch('eq-diff-command')}\n` +
        `[merge "a=b"]\n\tdriver = ${touch('eq-merge')}\n`,
    );
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
    writeFileSync(join(wt, 'b.eq'), 'two\n');
    expect(await driver.status(wt)).toBe(' M a.txt\n M b.eq');
    expect(await driver.diffStat(wt)).toMatch(/a\.txt \| 2 \+-\n b\.eq {2}\| 2 \+-/);
    const quiet = [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'filter.evil.clean=cat',
    ];
    const quietEnv = {
      ...process.env,
      ...gitConfigEnv([
        ['filter.x=y.clean', ''],
        ['filter.x=y.required', 'false'],
      ]),
    };
    execFileSync(
      'git',
      ['-C', wt, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...quiet, 'commit', '-qam', 'second'],
      {
        env: quietEnv,
      },
    );
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

  it("empties the repo's drivers, any name, and puts back the user's own values", () => {
    const entries = [
      { scope: 'global', key: 'core.sshcommand', value: 'ssh -i key' },
      { scope: 'local', key: 'core.sshcommand', value: 'evil' },
      { scope: 'local', key: 'core.alternaterefscommand', value: 'evil' },
      { scope: 'local', key: 'filter.LFS.clean', value: 'evil' },
      { scope: 'local', key: 'filter.x=y.smudge', value: 'evil' },
      { scope: 'local', key: 'diff.a=b.textconv', value: 'evil' },
      { scope: 'local', key: 'merge.a=b.driver', value: 'evil' },
      { scope: 'local', key: 'user.name', value: 'me' },
    ];
    expect(repoConfigGuard(entries)).toEqual([
      ['core.sshcommand', ''],
      ['core.sshcommand', 'ssh -i key'],
      ['core.alternaterefscommand', ''],
      ['core.alternaterefscommand', 'true'],
      ['filter.LFS.clean', ''],
      ['filter.LFS.required', 'false'],
      ['filter.x=y.smudge', ''],
      ['filter.x=y.required', 'false'],
      ['diff.a=b.textconv', ''],
      ['merge.a=b.driver', ''],
    ]);
    expect(gitConfigEnv([['filter.x=y.clean', '']])).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'filter.x=y.clean',
      GIT_CONFIG_VALUE_0: '',
    });
    expect(gitConfigEnv([])).toEqual({});
    expect(parseConfigList('local\0core.bare\nfalse\0local\0x.flag\0')).toEqual([
      { scope: 'local', key: 'core.bare', value: 'false' },
      { scope: 'local', key: 'x.flag', value: 'true' },
    ]);
  });
});

describe('RealGitDriver: credential helpers, git:// proxies, alternates, and a config it cannot read', () => {
  let dir: string;
  let home: string;
  let canary: string;
  const fired = () => readdirSync(canary).sort();
  const touch = (name: string) => `touch '${join(canary, name)}'`;
  // A clean HOME and no system config, so only this test's config counts.
  const env = () => ({ ...gitEnvironment({ PATH: process.env.PATH, HOME: home }), GIT_CONFIG_NOSYSTEM: '1' });
  const raw = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      env: env(),
      encoding: 'utf8',
    }).trim();
  const init = (name: string) => {
    const path = join(dir, name);
    execFileSync('git', ['init', '-q', '-b', 'main', path], { env: env() });
    raw(path, 'commit', '-q', '--allow-empty', '-m', 'first');
    return path;
  };

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'loop-git-guard-')));
    home = join(dir, 'home');
    canary = join(dir, 'canary');
    mkdirSync(home);
    mkdirSync(canary);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("keeps every helper of the user's own, general and for a URL, in order, over a repo's URL-scoped one", () => {
    // The user's own: a general helper that knows nothing, then gh's (as `gh auth setup-git` writes it).
    writeFileSync(
      join(home, '.gitconfig'),
      `[credential]\n\thelper = "!f() { ${touch('global-general')}; }; f"\n` +
        `[credential "https://github.example"]\n\thelper = "!f() { echo username=gh-user; echo password=gh-token; }; f"\n`,
    );
    const repo = init('cred');
    raw(
      repo,
      'config',
      'credential.https://github.example.helper',
      `!f() { ${touch('repo-helper')}; echo username=evil; echo password=evil; }; f`,
    );
    const config = execFileSync('git', ['-C', repo, 'config', '--list', '--show-scope', '-z'], {
      env: env(),
      encoding: 'utf8',
    });
    const answer = execFileSync('git', ['-C', repo, 'credential', 'fill'], {
      env: { ...env(), ...gitConfigEnv(repoConfigGuard(parseConfigList(config))) },
      input: 'protocol=https\nhost=github.example\n\n',
      encoding: 'utf8',
    });
    expect(answer).toContain('username=gh-user\npassword=gh-token');
    expect(fired()).toEqual(['global-general']);
  });

  it("never runs a repo's core.gitProxy or core.alternateRefsCommand", async () => {
    const driver = new RealGitDriver({ sourceEnv: { PATH: process.env.PATH, HOME: home } });
    writeFileSync(join(home, '.gitconfig'), '');
    const proxied = init('proxied');
    raw(proxied, 'remote', 'add', 'origin', 'git://127.0.0.1:9/x');
    raw(proxied, 'config', 'core.gitProxy', join(dir, 'proxy.sh'));
    writeFileSync(join(dir, 'proxy.sh'), `#!/bin/sh\n${touch('git-proxy')}\nexit 1\n`, { mode: 0o755 });
    await expect(driver.fetch(proxied, 'main')).rejects.toThrow();

    const upstream = join(dir, 'alt-up.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', upstream], { env: env() });
    const other = init('alt-other');
    raw(other, 'push', '-q', upstream, 'main:other');
    const borrower = init('alt-borrower');
    raw(borrower, 'remote', 'add', 'origin', upstream);
    writeFileSync(join(borrower, '.git/objects/info/alternates'), `${join(other, '.git/objects')}\n`);
    raw(borrower, 'config', 'core.alternateRefsCommand', `${touch('alternate-refs')}; exit 0`);
    await driver.fetch(borrower, 'other');
    expect(fired()).not.toContain('git-proxy');
    expect(fired()).not.toContain('alternate-refs');
  });

  it('runs no git in a repo whose config it cannot read in time (fails closed)', async () => {
    const driver = new RealGitDriver({
      sourceEnv: { PATH: process.env.PATH, HOME: home },
      configTimeoutMs: 500,
    });
    const repo = init('fifo');
    const fifo = join(dir, 'config.fifo');
    execFileSync('mkfifo', [fifo]);
    // Written directly: git config would try to read the FIFO too.
    appendFileSync(join(repo, '.git/config'), `[include]\n\tpath = ${fifo}\n`);
    await expect(driver.status(repo)).rejects.toThrow(/cannot read the git config in .*runs no git there/);
  });
});
