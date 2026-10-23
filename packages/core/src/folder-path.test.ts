import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkFolderProjectPath, checkReposAgainstFolders } from './folder-path.js';
import { openStore, type Store } from './store.js';

let root: string;
let home: string;
let worktrees: string;
let store: Store;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'loop-folder-')));
  home = join(root, 'home');
  worktrees = join(home, 'wt');
  for (const d of [home, worktrees, join(home, 'resume', 'old'), join(home, 'code', 'shop')])
    mkdirSync(d, { recursive: true });
  store = openStore();
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const check = (path: string, extra: Parameters<typeof checkFolderProjectPath>[1] = {}) =>
  checkFolderProjectPath(path, {
    home,
    protectedRoots: [worktrees],
    projects: store.projects.list(),
    ...extra,
  });

describe('checkFolderProjectPath', () => {
  it('accepts a plain folder and returns its canonical path', () => {
    expect(check(join(home, 'resume'))).toBe(join(home, 'resume'));
    symlinkSync(join(home, 'resume'), join(home, 'cv-link'));
    expect(check(join(home, 'cv-link'))).toBe(join(home, 'resume'));
  });

  it('refuses relative, missing and non-folder paths', () => {
    expect(() => check('resume')).toThrow(/must be absolute/);
    expect(() => check(join(home, 'nope'))).toThrow(/does not exist/);
    writeFileSync(join(home, 'file.txt'), 'x');
    expect(() => check(join(home, 'file.txt'))).toThrow(/is not a folder/);
  });

  it('refuses "/", the home folder, and a symlink to the home folder', () => {
    expect(() => check('/')).toThrow(/root folder/);
    expect(() => check(home)).toThrow(/home folder/);
    expect(() => check(`${home}/`)).toThrow(/home folder/);
    symlinkSync(home, join(root, 'home-link'));
    expect(() => check(join(root, 'home-link'))).toThrow(/home folder/);
  });

  it('refuses a folder inside WORKTREES_ROOT, the root itself, or one holding it', () => {
    mkdirSync(join(worktrees, 'shop', 'x'), { recursive: true });
    expect(() => check(join(worktrees, 'shop', 'x'))).toThrow(/overlaps .*runner/);
    expect(() => check(worktrees)).toThrow(/overlaps/);
    expect(() => check(root, { home: join(root, 'elsewhere') })).toThrow(/overlaps/);
    // Through a symlink pointing inside it too.
    symlinkSync(join(worktrees, 'shop'), join(home, 'sneaky'));
    expect(() => check(join(home, 'sneaky'))).toThrow(/overlaps/);
  });

  it('refuses nesting with registered projects, folder or git, either way', () => {
    store.projects.create({ name: 'resume', kind: 'folder', folderPath: join(home, 'resume') });
    store.projects.create({
      name: 'shop',
      repos: [{ name: 'web', path: join(home, 'code', 'shop'), remote: 'r', defaultBranch: 'main' }],
    });
    expect(() => check(join(home, 'resume'))).toThrow(/overlaps project "resume"/);
    expect(() => check(join(home, 'resume', 'old'))).toThrow(/overlaps project "resume"/);
    expect(() => check(join(home, 'code'))).toThrow(/overlaps project "shop"/);
    expect(() => check(join(home, 'code', 'shop'))).toThrow(/overlaps project "shop"/);
    mkdirSync(join(home, 'notes'));
    expect(check(join(home, 'notes'))).toBe(join(home, 'notes'));
  });

  it('refuses a git repo root unless allowGitFolder', () => {
    mkdirSync(join(home, 'repo', '.git'), { recursive: true });
    expect(() => check(join(home, 'repo'))).toThrow(/is a git repository: register .*allowGitFolder/);
    expect(check(join(home, 'repo'), { allowGitFolder: true })).toBe(join(home, 'repo'));
  });
});

// macOS volumes are case-insensitive by default: "/USERS/me" is the home folder.
const caseInsensitive = existsSync(tmpdir().toUpperCase()) && existsSync(homedir().toUpperCase());

describe.skipIf(!caseInsensitive)('checkFolderProjectPath on a case-insensitive disk', () => {
  it('refuses the real home folder typed in upper case', () => {
    expect(() => checkFolderProjectPath(homedir().toUpperCase())).toThrow(/home folder/);
  });

  it('refuses an upper-case protected root, and an upper-case parent that holds it', () => {
    expect(() => check(worktrees.toUpperCase())).toThrow(/overlaps/);
    mkdirSync(join(worktrees, 'deep'));
    expect(() => check(join(worktrees, 'deep').toUpperCase())).toThrow(/overlaps/);
    // The parent of the root (here also the test's home, so use another home).
    expect(() => check(dirname(worktrees).toUpperCase(), { home: join(root, 'elsewhere') })).toThrow(
      /overlaps/,
    );
  });

  it("refuses another project's folder in another case, and stores the on-disk case", () => {
    store.projects.create({ name: 'resume', kind: 'folder', folderPath: join(home, 'resume') });
    expect(() => check(join(home, 'resume').toUpperCase())).toThrow(/overlaps project "resume"/);
    expect(() => check(join(home, 'RESUME', 'old'))).toThrow(/overlaps project "resume"/);
    mkdirSync(join(home, 'notes'));
    expect(check(join(home, 'Notes'))).toBe(join(home, 'notes'));
  });
});

describe('checkFolderProjectPath denylist and git work trees', () => {
  it('refuses credential and agent-settings folders under home, and the Claude config folder', () => {
    for (const name of ['.claude', '.ssh', '.config', 'Library']) {
      mkdirSync(join(home, name, 'sub'), { recursive: true });
      expect(() => check(join(home, name)), name).toThrow(/credentials or agent settings/);
      expect(() => check(join(home, name, 'sub')), name).toThrow(/credentials or agent settings/);
    }
    mkdirSync(join(root, 'claude-cfg'));
    expect(() => check(join(root, 'claude-cfg'), { claudeConfigDir: join(root, 'claude-cfg') })).toThrow(
      /agent settings/,
    );
  });

  it('refuses the server repo and database folders passed as protected roots', () => {
    mkdirSync(join(home, 'server', 'data'), { recursive: true });
    const roots = [join(home, 'server'), join(home, 'server', 'data')];
    expect(() => check(join(home, 'server'), { protectedRoots: roots })).toThrow(/loop server/);
    expect(() => check(join(home, 'server', 'data'), { protectedRoots: roots })).toThrow(/loop server/);
  });

  it('refuses a folder inside a git work tree, not only its root, unless allowGitFolder', () => {
    mkdirSync(join(home, 'repo', '.git'), { recursive: true });
    mkdirSync(join(home, 'repo', 'docs', 'cv'), { recursive: true });
    expect(() => check(join(home, 'repo', 'docs', 'cv'))).toThrow(/inside the git repository .*repo/);
    expect(check(join(home, 'repo', 'docs'), { allowGitFolder: true })).toBe(join(home, 'repo', 'docs'));
  });

  it('refuses "#" in the path', () => {
    mkdirSync(join(home, 'a#b'));
    expect(() => check(join(home, 'a#b'))).toThrow(/may not contain "#"/);
  });

  it('keeps git repos off folder projects, both ways', () => {
    const folder = store.projects.create({ name: 'notes', kind: 'folder', folderPath: join(home, 'notes') });
    const repo = (path: string) => [{ name: 'web', path, remote: 'r', defaultBranch: 'main' }];
    const projects = store.projects.list();
    expect(() => checkReposAgainstFolders(repo(join(home, 'notes')), projects)).toThrow(
      /overlaps the folder/,
    );
    expect(() => checkReposAgainstFolders(repo(join(home, 'notes', 'x')), projects)).toThrow(/overlaps/);
    expect(() => checkReposAgainstFolders(repo(home), projects)).toThrow(/overlaps/);
    if (caseInsensitive)
      expect(() => checkReposAgainstFolders(repo(join(home, 'NOTES')), projects)).toThrow(/overlaps/);
    expect(() => checkReposAgainstFolders(repo(join(home, 'code', 'shop')), projects)).not.toThrow();
    expect(() => checkReposAgainstFolders(repo(join(home, 'notes')), projects, folder.id)).not.toThrow();
  });
});

describe('checkFolderProjectPath allowlist', () => {
  it("refuses dot-folders anywhere under home, ~/Library and ~/Applications (the reviewer's examples)", () => {
    for (const rel of [
      '.local',
      '.local/bin',
      '.opencode',
      '.docker',
      '.kube',
      '.cursor',
      '.codex',
      '.Trash',
      'work/.hidden/x',
    ]) {
      mkdirSync(join(home, rel), { recursive: true });
      expect(() => check(join(home, rel)), rel).toThrow(/hidden folder|credentials or agent settings/);
    }
    for (const rel of ['Library/Mobile Documents', 'Applications/Tool']) {
      mkdirSync(join(home, rel), { recursive: true });
      expect(() => check(join(home, rel)), rel).toThrow(/credentials|cannot hold project folders/);
    }
    mkdirSync(join(home, 'work', 'cv'), { recursive: true });
    expect(check(join(home, 'work', 'cv'))).toBe(join(home, 'work', 'cv'));
  });

  it('refuses folders outside home unless allowOutsideHome, and system folders always', () => {
    mkdirSync(join(root, 'outside'));
    expect(() => check(join(root, 'outside'), { home: join(root, 'home') })).toThrow(
      /outside your home folder/,
    );
    for (const system of [
      '/usr/local',
      '/Applications',
      '/Volumes',
      '/private/etc',
      '/opt/homebrew',
      '/usr',
    ]) {
      if (!existsSync(system)) continue;
      expect(() => check(system), system).toThrow(/outside your home folder/);
      expect(() => check(system, { allowOutsideHome: true }), system).toThrow(/system folder|whole disk/);
    }
    // The temp folder itself lives under /private on macOS: a system folder there too.
    if (root.startsWith('/private/')) {
      expect(() =>
        check(join(root, 'outside'), { home: '/nonexistent-home', allowOutsideHome: true }),
      ).toThrow(/system folder/);
    }
  });

  it('refuses folders on PATH, holding one, or holding an agent binary', () => {
    mkdirSync(join(home, 'tools', 'bin'), { recursive: true });
    mkdirSync(join(home, 'apps', 'claude-real'), { recursive: true });
    mkdirSync(join(home, 'links'));
    writeFileSync(join(home, 'apps', 'claude-real', 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    symlinkSync(join(home, 'apps', 'claude-real', 'claude'), join(home, 'links', 'claude'));
    const pathEnv = [join(home, 'tools', 'bin'), join(home, 'links'), 'relative/ignored'].join(':');
    expect(() => check(join(home, 'tools'), { pathEnv })).toThrow(/a folder on PATH/);
    expect(() => check(join(home, 'tools', 'bin'), { pathEnv })).toThrow(/a folder on PATH/);
    expect(() => check(join(home, 'apps'), { pathEnv })).toThrow(/holding the claude binary/);
    expect(() => check(join(home, 'apps', 'claude-real'), { pathEnv })).toThrow(/holding the claude binary/);
    expect(check(join(home, 'resume'), { pathEnv })).toBe(join(home, 'resume'));
  });
});
