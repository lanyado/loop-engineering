// GitWorkspace against real git: a bare "remote", a clone, and job checkouts.
import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Repo } from '@loop-engineering/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitEnvironment, GitWorkspace, JOB_CONFIG_PATHS } from './workspace.js';

const run = promisify(execFile);
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe('GitWorkspace', () => {
  let dir: string;
  let repo: Repo;
  let workspace: GitWorkspace;
  const git = (cwd: string, ...args: string[]) =>
    run('git', ['-C', cwd, '-c', 'user.name=B', '-c', 'user.email=b@test.invalid', ...args]).then((r) =>
      r.stdout.trim(),
    );

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loop-ws-'));
    const remote = join(dir, 'remote.git');
    const path = join(dir, 'repo');
    await run('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    await run('git', ['init', '-q', '-b', 'main', path]);
    await writeFile(join(path, 'a.txt'), 'a\n');
    // The PR carries its own agent configuration.
    await mkdir(join(path, '.claude'));
    await writeFile(join(path, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash"]}}\n');
    await writeFile(join(path, 'opencode.json'), '{"plugin":["evil"]}\n');
    await writeFile(join(path, '.mcp.json'), '{}\n');
    await git(path, 'add', '.');
    await git(path, 'commit', '-q', '-m', 'init');
    await git(path, 'remote', 'add', 'origin', remote);
    await git(path, 'push', '-q', 'origin', 'main', 'main:refs/heads/feature');
    repo = { name: 'web', path, remote, defaultBranch: 'main' };
    workspace = new GitWorkspace(join(dir, 'jobs'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("removes the PR's agent configuration from the job checkout only", async () => {
    const sha = await git(repo.path, 'rev-parse', 'HEAD');
    const path = await workspace.checkout({ repo, branch: 'feature', sha, name: 'pr1-review', envFiles: [] });
    for (const p of JOB_CONFIG_PATHS) expect(await exists(join(path, p))).toBe(false);
    expect(await exists(join(path, 'a.txt'))).toBe(true);
    expect(await exists(join(repo.path, '.claude', 'settings.json'))).toBe(true); // the user's checkout keeps it

    // The removal is never committed with the tester's files.
    await writeFile(join(path, 'a.test.txt'), 'test\n');
    const result = await workspace.commitAndPush(repo, path, {
      branch: 'feature',
      baseSha: sha,
      message: 'tests',
    });
    expect(result.status).toBe('pushed');
    const files = await git(repo.remote, 'ls-tree', '-r', '--name-only', 'feature');
    expect(files.split('\n').sort()).toEqual([
      '.claude/settings.json',
      '.mcp.json',
      'a.test.txt',
      'a.txt',
      'opencode.json',
    ]);
  });

  it("commits as the repo's git user, so deploy hosts accept the commit", async () => {
    await git(repo.path, 'config', 'user.name', 'Ada');
    await git(repo.path, 'config', 'user.email', 'ada@example.com');
    const sha = await git(repo.path, 'rev-parse', 'HEAD');
    const path = await workspace.checkout({ repo, branch: 'feature', sha, name: 'pr1-tests', envFiles: [] });
    await writeFile(join(path, 'c.test.txt'), 'test\n');
    const result = await workspace.commitAndPush(repo, path, {
      branch: 'feature',
      baseSha: sha,
      message: 'tests',
    });
    expect(result.status).toBe('pushed');
    expect(await git(repo.remote, 'log', '-1', '--format=%an <%ae>', 'feature')).toBe(
      'Ada <ada@example.com>',
    );
  });

  it('never runs hooks or an fsmonitor a job planted in the shared repo config', async () => {
    const sha = await git(repo.path, 'rev-parse', 'HEAD');
    const path = await workspace.checkout({ repo, branch: 'feature', sha, name: 'pr1-tests', envFiles: [] });
    const marker = join(dir, 'pwned');
    const script = join(dir, 'evil.sh');
    await writeFile(script, `#!/bin/sh\necho "$0 $DASHBOARD_TOKEN" >> ${marker}\n`);
    await chmod(script, 0o755);
    // What a tester shell could do: hooks in .git/hooks and core.fsmonitor in the repo config.
    const hooks = join(repo.path, '.git', 'hooks');
    for (const hook of ['post-commit', 'pre-push', 'pre-commit', 'reference-transaction']) {
      await writeFile(join(hooks, hook), `#!/bin/sh\n${script}\n`);
      await chmod(join(hooks, hook), 0o755);
    }
    await git(repo.path, 'config', 'core.fsmonitor', script);
    await writeFile(join(path, 'b.test.txt'), 'test\n');
    const result = await workspace.commitAndPush(repo, path, {
      branch: 'feature',
      baseSha: sha,
      message: 'tests',
    });
    expect(result.status).toBe('pushed');
    expect(await exists(marker)).toBe(false);
  });

  it('never runs filters, drivers, credential helpers or an sshCommand a job planted in the shared repo config', async () => {
    // The PR's files ask for filters by name, one with "=" in it (no `-c key=value` can name that).
    const path0 = repo.path;
    await writeFile(join(path0, '.gitattributes'), '* filter=evil diff=evil\n*.eq filter=x=y\n');
    await writeFile(join(path0, 'b.eq'), 'b\n');
    await git(path0, 'add', '.');
    await git(path0, 'commit', '-q', '-m', 'attributes');
    await git(path0, 'push', '-q', 'origin', 'main:refs/heads/feature');
    const sha = await git(path0, 'rev-parse', 'HEAD');
    // What a job could write into the .git its checkout shares with the builder's repo.
    const canary = join(dir, 'canary');
    await mkdir(canary);
    const touch = (name: string) => `touch '${join(canary, name)}'`;
    await git(path0, 'config', 'filter.evil.clean', `${touch('filter-clean')}; cat`);
    await git(path0, 'config', 'filter.evil.smudge', `${touch('filter-smudge')}; cat`);
    await git(path0, 'config', 'filter.evil.required', 'true');
    await git(path0, 'config', 'diff.evil.textconv', `${touch('textconv')}; cat`);
    await git(path0, 'config', 'credential.helper', `!${touch('credential')}`);
    await git(path0, 'config', 'core.sshCommand', touch('ssh'));
    await git(path0, 'config', 'core.pager', touch('pager'));
    await appendFile(
      join(path0, '.git', 'config'),
      `[filter "x=y"]\n\tclean = ${touch('eq-clean')}; cat\n\tsmudge = ${touch('eq-smudge')}; cat\n\trequired = true\n`,
    );
    const path = await workspace.checkout({ repo, branch: 'feature', sha, name: 'pr1-tests', envFiles: [] });
    await writeFile(join(path, 'a.txt'), 'changed\n');
    await writeFile(join(path, 'b.eq'), 'changed\n');
    const result = await workspace.commitAndPush(repo, path, {
      branch: 'feature',
      baseSha: sha,
      message: 'tests',
    });
    expect(result.status).toBe('pushed');
    expect(await git(repo.remote, 'show', 'feature:b.eq')).toBe('changed');
    expect(await readdir(canary)).toEqual([]);
  });

  it('runs no git where the repo config cannot be read in time (fails closed)', async () => {
    const sha = await git(repo.path, 'rev-parse', 'HEAD');
    const fifo = join(dir, 'config.fifo');
    await run('mkfifo', [fifo]);
    // Written directly: git config would try to read the FIFO too.
    await appendFile(join(repo.path, '.git', 'config'), `[include]\n\tpath = ${fifo}\n`);
    const stuck = new GitWorkspace(join(dir, 'jobs'), { configTimeoutMs: 300 });
    await expect(
      stuck.checkout({ repo, branch: 'feature', sha, name: 'pr1-review', envFiles: [] }),
    ).rejects.toThrow(/cannot read the git config in .*runs no git there/);
    expect(await exists(join(dir, 'jobs', 'pr1-review'))).toBe(false);
  });

  it('gives git only what a push needs, none of the server secrets and no core.gitProxy', () => {
    expect(
      gitEnvironment({
        PATH: '/bin',
        HOME: '/h',
        SSH_AUTH_SOCK: '/s',
        DASHBOARD_TOKEN: 'd',
        MCP_TOKEN: 'm',
        GH_TOKEN: 'g',
        GITHUB_TOKEN: 'g',
        EMAIL_APP_PASSWORD: 'e',
      }),
    ).toEqual({
      PATH: '/bin',
      HOME: '/h',
      SSH_AUTH_SOCK: '/s',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PROXY_COMMAND: '',
    });
  });
});
