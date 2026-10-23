import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, FolderBusyError, openStore, ValidationError } from '@loop-engineering/core';
import { describe, expect, it } from 'vitest';
import { DefaultAgentCli } from './agent-cli.js';
import { nodeFs } from './drivers/fs.js';
import { FakeGitDriver, FakeTmuxDriver } from './fakes.js';
import { SessionRunner } from './runner.js';
import { harness } from './test-support/harness.js';

const FOLDER = '/home/me/resume';

function setup(folderPath = FOLDER) {
  const h = harness();
  h.fs.dirs.add(FOLDER);
  h.fs.files.set(`${FOLDER}/cv.md`, { content: '# CV\n' });
  const resume = h.store.projects.create({ name: 'Resume', kind: 'folder', folderPath });
  /** Every path the fake fs holds under the folder. */
  const inFolder = () =>
    [...h.fs.files.keys(), ...h.fs.dirs].filter((p) => p === FOLDER || p.startsWith(`${FOLDER}/`)).sort();
  return { ...h, resume, inFolder };
}

describe('folder projects in the runner', () => {
  it('launches the agent in the folder: no branch, worktree, env copy or skill, state in the state dir', async () => {
    const h = setup();
    const s = await h.runner.startSession(h.resume.id, { text: 'Update my resume' });
    expect(s).toMatchObject({ status: 'active', branch: '', worktrees: [], tmuxTarget: 'loop:@1' });
    const w = h.window(s.tmuxTarget);
    expect(w.cwd).toBe(FOLDER);
    expect(h.script(w)).toContain(`cd '${FOLDER}' || exit 1`);
    expect(h.git.worktrees.size).toBe(0);
    expect(h.inFolder()).toEqual([FOLDER, `${FOLDER}/cv.md`]);
    expect(await h.fs.exists(`/wt/.loop-runner/s${s.id}/mcp.json`)).toBe(true);
    expect(
      [...h.fs.files.keys()].some((p) => p.startsWith('/wt/') && !p.startsWith('/wt/.loop-runner/')),
    ).toBe(false);
    expect(h.store.requests.list({ sessionId: s.id }).map((r) => r.text)).toEqual(['Update my resume']);
  });

  it('allows one open session per folder: a second start is FolderBusyError until the first ends', async () => {
    const h = setup();
    const first = await h.runner.startSession(h.resume.id, { text: 'one' });
    const busy = h.runner.startSession(h.resume.id, { text: 'two' });
    await expect(busy).rejects.toBeInstanceOf(FolderBusyError);
    await expect(busy).rejects.toThrow(/folder busy/);
    await h.runner.pause(first.id, 'manual');
    await expect(h.runner.startSession(h.resume.id, { text: 'two' })).rejects.toBeInstanceOf(FolderBusyError);
    // Concurrent starts: exactly one wins.
    await h.runner.end(first.id);
    const results = await Promise.allSettled([
      h.runner.startSession(h.resume.id, { text: 'a' }),
      h.runner.startSession(h.resume.id, { text: 'b' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(h.store.sessions.list({ projectId: h.resume.id, status: ['active', 'paused'] })).toHaveLength(1);
  });

  it('end() only stops the session: every file in the folder stays, runner state goes', async () => {
    const h = setup();
    const s = await h.runner.startSession(h.resume.id, { text: 'Update my resume' });
    await h.runner.deliverFile(s.id, 'request-9.md', 'more', 'Read .loop/request-9.md');
    h.fs.files.set(`${FOLDER}/cv.md`, { content: '# CV (edited by the agent)\n' });
    const before = new Map([...h.fs.files].filter(([p]) => p.startsWith(`${FOLDER}/`)));
    const ended = await h.runner.end(s.id);
    expect(ended.status).toBe('ended');
    expect(new Map([...h.fs.files].filter(([p]) => p.startsWith(`${FOLDER}/`)))).toEqual(before);
    expect(h.fs.dirs.has(FOLDER)).toBe(true);
    expect(await h.fs.exists(`/wt/.loop-runner/s${s.id}`)).toBe(false);
    expect(h.tmux.windows.size).toBe(0);
  });

  it('deliverFile writes .loop/<name> and .loop/.gitignore ("*") in the folder', async () => {
    const h = setup();
    const s = await h.runner.startSession(h.resume.id, { text: 'Update my resume' });
    const rel = await h.runner.deliverFile(s.id, 'request-2.md', '# Request', 'Read .loop/request-2.md');
    expect(rel).toBe('.loop/request-2.md');
    expect(h.fs.files.get(`${FOLDER}/.loop/request-2.md`)).toEqual({ content: '# Request', mode: 0o600 });
    expect(h.fs.read(`${FOLDER}/.loop/.gitignore`)).toBe('*\n');
    expect(h.inFolder().filter((p) => !p.startsWith(`${FOLDER}/.loop`))).toEqual([FOLDER, `${FOLDER}/cv.md`]);
    expect(h.window(s.tmuxTarget).keys).toBe('Read .loop/request-2.md\n');
  });

  it('refuses a symlinked .loop in the folder', async () => {
    const h = setup();
    const s = await h.runner.startSession(h.resume.id, { text: 'x' });
    h.fs.symlinks.add(`${FOLDER}/.loop`);
    await expect(h.runner.deliverFile(s.id, 'r.md', 'x', 'Read .loop/r.md')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('resumes and falls back to OpenCode in the folder with a folder continuation prompt', async () => {
    const h = setup();
    const s = await h.runner.startSession(h.resume.id, { text: 'Update my resume' });
    await h.runner.pause(s.id, 'manual');
    const resumed = await h.runner.resume(s.id);
    expect(h.window(resumed.tmuxTarget).cwd).toBe(FOLDER);
    const switched = await h.runner.fallbackToOpencode(s.id, 'usage limit reached');
    const script = h.script(h.window(switched?.tmuxTarget ?? null));
    expect(script).toContain(`cd '${FOLDER}'`);
    expect(script).toContain('## Folder');
    expect(script).not.toContain('## Branch');
  });

  it('refuses to start when the folder is gone or overlaps the runner folders', async () => {
    const gone = setup('/home/me/missing');
    await expect(gone.runner.startSession(gone.resume.id, { text: 'x' })).rejects.toThrow(/does not exist/);
    const inside = setup('/wt/notes');
    inside.fs.dirs.add('/wt/notes');
    await expect(inside.runner.startSession(inside.resume.id, { text: 'x' })).rejects.toThrow(/overlaps/);
    const holding = setup('/');
    await expect(holding.runner.startSession(holding.resume.id, { text: 'x' })).rejects.toThrow(/overlaps/);
    // Nothing was left behind: no open session blocks a later start.
    expect(gone.store.sessions.list({ status: ['active', 'paused'] })).toEqual([]);
  });
});

describe('folder session states (what the router does with a new request)', () => {
  it('live, paused-manual, resumable (usage limit), dead (agent exited, window gone, never launched), ended', async () => {
    const h = setup();
    const s = await h.runner.startSession(h.resume.id, { text: 'one' });
    expect(await h.runner.sessionState(s.id)).toBe('live');
    await h.runner.pause(s.id, 'manual');
    expect(await h.runner.sessionState(s.id)).toBe('paused-manual');
    h.store.sessions.update(s.id, { status: 'paused', pauseReason: 'usage_limit' });
    expect(await h.runner.sessionState(s.id)).toBe('resumable');
    h.store.sessions.update(s.id, { status: 'paused', pauseReason: 'agent_exited' });
    expect(await h.runner.sessionState(s.id)).toBe('dead');
    const resumed = await h.runner.resume(s.id);
    h.window(resumed.tmuxTarget).dead = true;
    expect(await h.runner.sessionState(s.id)).toBe('dead');
    h.store.sessions.update(s.id, { status: 'active', tmuxTarget: null }); // a crash mid-start
    expect(await h.runner.sessionState(s.id)).toBe('dead');
    await h.runner.end(s.id);
    expect(await h.runner.sessionState(s.id)).toBe('ended');
  });

  it('resume with deliver writes .loop/<name> before the launch and names it in the first prompt', async () => {
    const h = setup();
    const s = await h.runner.startSession(h.resume.id, { text: 'one' });
    await h.runner.pause(s.id, 'manual');
    await h.saveConversation(s.agentSessionId);
    const resumed = await h.runner.resume(s.id, {
      deliver: { name: 'request-5.md', content: '# Request 5', sentence: 'Read the file .loop/request-5.md' },
    });
    expect(resumed.status).toBe('active');
    expect(h.fs.read(`${FOLDER}/.loop/request-5.md`)).toBe('# Request 5');
    expect(h.fs.read(`${FOLDER}/.loop/.gitignore`)).toBe('*\n');
    expect(h.script(h.window(resumed.tmuxTarget))).toContain('Read the file .loop/request-5.md');
    expect(h.window(resumed.tmuxTarget).keys).toBe('');
  });

  it('reconcile ends a folder session whose agent is gone (git sessions stay paused), files untouched', async () => {
    const h = setup();
    const folderSession = await h.runner.startSession(h.resume.id, { text: 'one' });
    const gitSession = await h.runner.startSession(h.shop.id, { text: 'two' });
    h.window(folderSession.tmuxTarget).dead = true;
    h.window(gitSession.tmuxTarget).dead = true;
    const before = h.inFolder();
    const touched = await h.runner.reconcile();
    expect(touched.map((s) => [s.id, s.status]).sort()).toEqual([
      [folderSession.id, 'ended'],
      [gitSession.id, 'paused'],
    ]);
    expect(h.inFolder()).toEqual(before);
    expect(h.store.history.list({ projectId: h.resume.id }).map((e) => e.text)).toEqual([
      expect.stringContaining('Session ended so the folder is free'),
    ]);
    // The folder is free again.
    await expect(h.runner.startSession(h.resume.id, { text: 'three' })).resolves.toMatchObject({
      status: 'active',
    });
  });
});

describe('folder checks at every launch, on a real disk', () => {
  async function realSetup() {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'loop-folder-runner-')));
    const folder = join(dir, 'notes');
    await mkdir(folder);
    await writeFile(join(folder, 'a.md'), 'a\n');
    const store = openStore({ clock: new FakeClock() });
    const tmux = new FakeTmuxDriver();
    const runner = new SessionRunner(
      {
        store,
        fs: nodeFs,
        git: new FakeGitDriver(nodeFs),
        tmux,
        agentCli: new DefaultAgentCli(),
        log: () => undefined,
      },
      {
        worktreesRoot: join(dir, 'wt'),
        serverUrl: 'http://srv',
        claudeProjectsDir: join(dir, 'c'),
        env: { MCP_TOKEN: 't' },
      },
    );
    return { dir, folder, store, runner, tmux };
  }

  it('refuses to launch, resume or deliver once the folder was swapped for a symlink', async () => {
    const { dir, folder, store, runner } = await realSetup();
    try {
      const project = store.projects.create({ name: 'notes', kind: 'folder', folderPath: folder });
      const s = await runner.startSession(project.id, { text: 'one' });
      await runner.pause(s.id, 'manual');
      // Swap: the folder moves away and a symlink to elsewhere takes its name.
      await rename(folder, join(dir, 'moved'));
      await mkdir(join(dir, 'elsewhere'));
      await symlink(join(dir, 'elsewhere'), folder);
      await expect(runner.resume(s.id)).rejects.toThrow(/now resolves to .*elsewhere/);
      await runner.end(s.id);
      await expect(runner.startSession(project.id, { text: 'two' })).rejects.toThrow(/now resolves to/);
      expect(store.sessions.list({ status: ['active', 'paused'] })).toEqual([]);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a stored path whose letter case differs from the disk (case-insensitive volumes)', async () => {
    const { dir, folder, store, runner } = await realSetup();
    try {
      const upper = folder.replace(/notes$/, 'NOTES');
      const insensitive = await realpath(upper).then(
        () => true,
        () => false,
      );
      if (!insensitive) return;
      const project = store.projects.create({ name: 'n', kind: 'folder', folderPath: upper });
      await expect(runner.startSession(project.id, { text: 'x' })).rejects.toThrow(/now resolves to .*notes/);
      const inRoot = store.projects.create({ name: 'w', kind: 'folder', folderPath: join(dir, 'WT') });
      await mkdir(join(dir, 'wt'));
      await expect(runner.startSession(inRoot.id, { text: 'x' })).rejects.toThrow(
        /overlaps the runner folder/,
      );
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
