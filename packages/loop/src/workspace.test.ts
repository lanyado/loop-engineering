// GitWorkspace against real git: a bare "remote", a clone, and job checkouts.
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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
    await git(repo.path, 'config', 'user.name', 'Rotem');
    await git(repo.path, 'config', 'user.email', 'rotem@example.com');
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
      'Rotem <rotem@example.com>',
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

  it('gives git only what a push needs, none of the server secrets', () => {
    expect(
      gitEnvironment({
        PATH: '/bin',
        HOME: '/h',
        SSH_AUTH_SOCK: '/s',
        DASHBOARD_TOKEN: 'd',
        MCP_TOKEN: 'm',
        GH_TOKEN: 'g',
      }),
    ).toEqual({ PATH: '/bin', HOME: '/h', SSH_AUTH_SOCK: '/s', GIT_TERMINAL_PROMPT: '0' });
  });
});
