import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RealGitDriver } from './git.js';

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
