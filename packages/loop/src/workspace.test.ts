// GitWorkspace against real git: a bare "remote", a clone, and job checkouts.
import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

  it('runs its git writes in the shared repo one at a time, across workspaces (engine and Guardian)', async () => {
    // A git that fails when another of these commands is running in the repo: what git's own ref
    // locks do to concurrent fetches into refs/remotes/origin/<branch>, made certain.
    const real = (await run('sh', ['-c', 'command -v git'])).stdout.trim();
    const busy = join(dir, 'busy');
    const probe = join(dir, 'git-probe');
    await writeFile(
      probe,
      [
        '#!/bin/sh',
        'case " $* " in',
        '  *" fetch "*|*" worktree "*|*" update-ref "*)',
        `    mkdir '${busy}' 2>/dev/null || { echo 'probe: two git writes in the repo at once' >&2; exit 3; }`,
        '    sleep 0.2',
        `    '${real}' "$@"; code=$?`,
        `    rmdir '${busy}'`,
        '    exit $code ;;',
        'esac',
        `exec '${real}' "$@"`,
        '',
      ].join('\n'),
    );
    await chmod(probe, 0o755);
    const sha = await git(repo.path, 'rev-parse', 'HEAD');
    const engine = new GitWorkspace(join(dir, 'jobs'), { git: probe });
    const guardian = new GitWorkspace(join(dir, 'jobs'), { git: probe });
    const owners = [engine, guardian, engine, guardian];
    const paths = await Promise.all(
      owners.map((w, i) => w.checkout({ repo, branch: 'feature', sha, name: `job${i}`, envFiles: [] })),
    );
    for (const path of paths) expect(await exists(join(path, 'a.txt'))).toBe(true);
    await Promise.all(paths.map((path, i) => owners[i]!.remove(repo, path)));
    expect(await git(repo.path, 'worktree', 'list')).not.toContain('job');
  });

  it('waits out a ref lock that a git Loop does not run holds in the shared repo', async () => {
    // The branch moved on the remote (pushed by URL, so origin/feature is behind): the job's fetch
    // has to write refs/remotes/origin/feature, which a builder's own fetch holds for a moment.
    await writeFile(join(repo.path, 'b.txt'), 'b\n');
    await git(repo.path, 'add', 'b.txt');
    await git(repo.path, 'commit', '-q', '-m', 'b');
    await git(repo.path, 'push', '-q', repo.remote, 'HEAD:refs/heads/feature');
    const sha = await git(repo.path, 'rev-parse', 'HEAD');
    const lock = join(repo.path, '.git', 'refs', 'remotes', 'origin', 'feature.lock');
    await writeFile(lock, '');
    const unlock = setTimeout(() => void rm(lock, { force: true }), 300);
    try {
      const path = await workspace.checkout({ repo, branch: 'feature', sha, name: 'pr1-qa', envFiles: [] });
      expect(await exists(join(path, 'b.txt'))).toBe(true);
      expect(await git(repo.path, 'rev-parse', 'refs/remotes/origin/feature')).toBe(sha);
    } finally {
      clearTimeout(unlock);
      await rm(lock, { force: true });
    }
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

  it('never runs anything a job planted in the shared repo config: filters, drivers, signing, tools, includes', async () => {
    // The PR's files ask for filters by name, one with "=" in it (no `-c key=value` can name that).
    const path0 = repo.path;
    // And filters only included config defines, each its own, so neutralizing one never hides another.
    const included = ['gitdir', 'hasconfig', 'include'];
    await writeFile(
      join(path0, '.gitattributes'),
      `* filter=evil diff=evil\n*.eq filter=x=y\n${included.map((f) => `*.${f} filter=${f}\n`).join('')}`,
    );
    await writeFile(join(path0, 'b.eq'), 'b\n');
    for (const f of included) await writeFile(join(path0, `c.${f}`), `${f}\n`);
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
    // Signing in ssh format with a key command, signing and editing programs, tools Loop never runs.
    const planted: [string, string][] = [
      ['commit.gpgSign', 'true'],
      ['tag.gpgSign', 'true'],
      ['gpg.format', 'ssh'],
      ['gpg.ssh.defaultKeyCommand', touch('ssh-key-command')],
      ['gpg.ssh.program', touch('ssh-sign')],
      ['gpg.program', touch('gpg')],
      ['core.editor', touch('editor')],
      ['sequence.editor', touch('sequence-editor')],
      ['core.askPass', touch('askpass')],
      ['diff.external', touch('diff-external')],
      ['core.alternateRefsCommand', touch('alternate-refs')],
      ['trailer.t.command', touch('trailer')],
      ['mergetool.m.cmd', touch('mergetool')],
    ];
    for (const [key, value] of planted) await git(path0, 'config', key, value);
    // A remote named origin pointing elsewhere, with its own upload-pack: the loop fetches by URL.
    const decoy = join(dir, 'decoy.git');
    await run('git', ['clone', '-q', '--bare', repo.remote, decoy]);
    await git(path0, 'config', 'remote.origin.url', decoy);
    await git(path0, 'config', 'remote.origin.uploadpack', `${touch('uploadpack')}; git-upload-pack`);
    // On the remote's side git takes this only from the user's own config, never from a repo's.
    await git(repo.remote, 'config', 'uploadpack.packObjectsHook', touch('pack-objects-hook'));
    // Config that applies only as the job's worktree (whose git dir is .git/worktrees/<name>), or
    // through an include.
    const evil = async (name: string) => {
      const file = join(dir, `${name}.inc`);
      await writeFile(
        file,
        `[filter "${name}"]\n\tclean = ${touch(`${name}-clean`)}; cat\n\tsmudge = ${touch(`${name}-smudge`)}; cat\n`,
      );
      return file;
    };
    await appendFile(
      join(path0, '.git', 'config'),
      `[includeIf "gitdir:**/worktrees/**"]\n\tpath = ${await evil('gitdir')}\n` +
        `[includeIf "hasconfig:remote.*.url:**/decoy.git"]\n\tpath = ${await evil('hasconfig')}\n` +
        `[include]\n\tpath = ${await evil('include')}\n`,
    );
    const path = await workspace.checkout({ repo, branch: 'feature', sha, name: 'pr1-tests', envFiles: [] });
    expect(await readFile(join(path, 'b.eq'), 'utf8')).toBe('b\n');
    // The checkout runs as the new worktree, where the gitdir include applies: nothing fired yet.
    expect(await readdir(canary)).toEqual([]);
    await writeFile(join(path, 'a.txt'), 'changed\n');
    await writeFile(join(path, 'b.eq'), 'changed\n');
    for (const f of included) await writeFile(join(path, `c.${f}`), 'changed\n');
    const result = await workspace.commitAndPush(repo, path, {
      branch: 'feature',
      baseSha: sha,
      message: 'tests',
    });
    expect(result.status).toBe('pushed');
    expect(await git(repo.remote, 'show', 'feature:b.eq')).toBe('changed');
    // Unsigned, though the repo asks for signing.
    expect(await git(repo.remote, 'cat-file', 'commit', 'feature')).not.toContain('gpgsig');
    await workspace.remove(repo, path);
    expect(await readdir(canary)).toEqual([]);
  });

  it('cannot be made to fail its commits by a job asking for signing with a program of its own', async () => {
    const sha = await git(repo.path, 'rev-parse', 'HEAD');
    const canary = join(dir, 'gpg-ran');
    await git(repo.path, 'config', 'commit.gpgSign', 'true');
    await git(repo.path, 'config', 'gpg.program', `touch '${canary}'`);
    const path = await workspace.checkout({ repo, branch: 'feature', sha, name: 'pr1-tests', envFiles: [] });
    await writeFile(join(path, 'd.test.txt'), 'test\n');
    const result = await workspace.commitAndPush(repo, path, {
      branch: 'feature',
      baseSha: sha,
      message: 'tests',
    });
    expect(result.status).toBe('pushed');
    expect(await exists(canary)).toBe(false);
  });

  it('never fetches through an ext:: transport a job planted, whatever protocol.ext.allow it sets', async () => {
    const sha = await git(repo.path, 'rev-parse', 'HEAD');
    const canary = join(dir, 'ext-ran');
    const script = join(dir, 'ext.sh');
    await writeFile(script, `#!/bin/sh\ntouch '${canary}'\n`);
    await chmod(script, 0o755);
    await git(repo.path, 'config', 'protocol.ext.allow', 'always');
    await git(repo.path, 'config', `url.ext::${script}.insteadOf`, repo.remote);
    await expect(
      workspace.checkout({ repo, branch: 'feature', sha, name: 'pr1-tests', envFiles: [] }),
    ).rejects.toThrow(/ext/);
    expect(await exists(canary)).toBe(false);
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
    // Not an answer of "no": the engine's step fails and is tried again.
    await expect(stuck.isAncestor(repo, sha, 'HEAD')).rejects.toThrow(/cannot read the git config/);
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
        GH_CONFIG_DIR: '/gh',
        GH_HOST: 'github.example',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/bus',
        XDG_DATA_HOME: '/d',
        XDG_RUNTIME_DIR: '/r',
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
