/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any --
   These tests poke at JSON responses; asserting their exact shape is the point. */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTimers } from '@loop-engineering/ask-human';
import { FakeClock, openStore, type Store } from '@loop-engineering/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../config.js';
import { createServer, type LoopServer } from '../server.js';
import { ensureRouterSession } from '@loop-engineering/router';
// The runner's own test harness: a real SessionRunner on fake tmux, git and fs.
import { harness as runnerHarness } from '../../../../packages/runner/src/test-support/harness.js';
import { REPO_ROOT } from '../env.js';
import { dashboardApi } from './dashboard-api.js';

const caseInsensitive = existsSync(tmpdir().toUpperCase());

const TOKEN = 'dashboard-token-for-tests-0001';
const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  dbPath: ':memory:',
  dashboardToken: TOKEN,
  mcpToken: 'mcp-token-for-tests-00000000001',
  corsOrigins: [],
  publicUrl: null,
};

let store: Store;
let server: LoopServer;
let clock: FakeClock;

beforeEach(() => {
  clock = new FakeClock('2026-10-18T09:00:00.000Z');
  store = openStore({ clock });
  // Not started: app.request() drives the routes in-process.
  server = createServer({ config, store, timers: new FakeTimers(clock), modules: [dashboardApi()] });
});
afterEach(async () => {
  await server.close();
  store.close();
});

async function call(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let payload: string | undefined;
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await server.app.request(`/api${path}`, { method, headers, body: payload });
  const raw = await res.text();
  // 401s from bearerAuth are plain text.
  const json = (raw.startsWith('{') ? JSON.parse(raw) : { text: raw }) as Record<string, any>;
  return { status: res.status, json };
}

const repo = {
  name: 'web',
  path: '/Users/me/web',
  remote: 'git@github.com:me/web.git',
  defaultBranch: 'main',
};

function seed() {
  const shop = store.projects.create({ name: 'shop', repos: [repo] });
  const blog = store.projects.create({ name: 'blog' });
  const s1 = store.sessions.create({ projectId: shop.id, title: 'checkout', model: 'opus', branch: 'b1' });
  const s2 = store.sessions.create({
    projectId: shop.id,
    title: 'search',
    model: 'glm',
    provider: 'opencode',
    branch: 'b2',
    status: 'paused',
    pauseReason: 'usage_limit',
  });
  const ended = store.sessions.create({ projectId: shop.id, title: 'old', model: 'opus', branch: 'b3' });
  store.sessions.end(ended.id);
  const sub = store.subagents.create({ sessionId: s1.id, title: 'tests', model: 'sonnet', effort: 'high' });
  server.ctx.questions.ask({
    sessionId: s1.id,
    subagentId: sub.id,
    text: 'Which DB?',
    options: ['SQLite', 'Postgres'],
    recommendedOption: 'SQLite',
  });
  const request = store.requests.create({ projectId: shop.id, text: 'Add Apple Pay', source: 'telegram' });
  const pr = store.pullRequests.create({
    projectId: shop.id,
    repo: 'web',
    number: 42,
    url: 'https://github.com/me/web/pull/42',
    sessionId: s1.id,
    requestId: request.id,
  });
  store.metrics.record(pr.id, { costUsd: 1.25, tokensIn: 1000, tokensOut: 200, failures: 1 });
  clock.advance(1000);
  const pr2 = store.pullRequests.create({ projectId: shop.id, repo: 'web', number: 43, url: 'u43' });
  store.pullRequests.update(pr2.id, { stage: 'deployed', outcome: 'merged', round: 2 });
  return { shop, blog, s1, s2, ended, sub, request, pr, pr2 };
}

describe('auth', () => {
  it('needs the dashboard token on every route', async () => {
    for (const path of ['/projects', '/tree', '/requests', '/prs', '/metrics', '/settings']) {
      expect((await call('GET', path, undefined, null)).status).toBe(401);
      expect((await call('GET', path, undefined, 'wrong-token-wrong-token')).status).toBe(401);
    }
    expect((await call('PATCH', '/settings', { sessionModel: 'x' }, null)).status).toBe(401);
    expect(store.settings.get().sessionModel).toBe('opus');
  });
});

describe('projects', () => {
  it('creates, reads, updates and deletes', async () => {
    const created = await call('POST', '/projects', { name: 'shop', repos: [repo] });
    expect(created.status).toBe(201);
    expect(created.json.project).toMatchObject({
      name: 'shop',
      autoMerge: false,
      markedForDirectInput: false,
      permissionMode: 'auto',
    });
    const id = created.json.project.id as number;

    expect((await call('GET', '/projects')).json.projects).toHaveLength(1);
    expect((await call('GET', `/projects/${id}`)).json.project.repos).toEqual([repo]);

    const toggled = await call('PATCH', `/projects/${id}`, { autoMerge: true, markedForDirectInput: true });
    expect(toggled.json.project).toMatchObject({ autoMerge: true, markedForDirectInput: true });
    expect(store.projects.require(id).autoMerge).toBe(true);
    const mode = await call('PATCH', `/projects/${id}`, { permissionMode: 'acceptEdits' });
    expect(mode.json.project.permissionMode).toBe('acceptEdits');
    // bypassPermissions is a local-only setting: the dashboard can never turn it on.
    const bypass = await call('PATCH', `/projects/${id}`, { permissionMode: 'bypassPermissions' });
    expect(bypass.status).toBe(400);
    expect(bypass.json.error).toMatch(/only be set locally/);
    expect((await call('POST', '/projects', { name: 'x', permissionMode: 'bypassPermissions' })).status).toBe(
      400,
    );
    expect(store.projects.require(id).permissionMode).toBe('acceptEdits');

    expect((await call('DELETE', `/projects/${id}`)).json).toEqual({ deleted: true });
    expect((await call('GET', `/projects/${id}`)).status).toBe(404);
    expect((await call('DELETE', `/projects/${id}`)).status).toBe(404);
  });

  it('rejects invalid writes', async () => {
    const bad: unknown[] = [
      {},
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(101) },
      { name: 'p', autoMerge: 'yes' },
      { name: 'p', permissionMode: 'yolo' },
      { name: 'p', repos: [{ ...repo, name: 'bad name' }] }, // core: unsafe repo name
      { name: 'p', extra: 1 },
      { name: 'p', repos: [{ ...repo, path: 'relative/path' }] },
      { name: 'p', repos: [{ ...repo, extra: true }] },
      { name: 'p', repos: [repo], envFiles: [{ repo: 'web', source: '/a/.env', target: '../escape' }] },
      { name: 'p', repos: [repo], envFiles: [{ repo: 'web', source: '/a/.env', target: '/etc/passwd' }] },
      { name: 'p', repos: [repo, repo] }, // duplicate repo name (core validation)
      { name: 'p', envFiles: [{ repo: 'nope', source: '/a/.env', target: '.env' }] }, // unknown repo
      'not json',
      [],
    ];
    for (const body of bad) {
      const res = await call('POST', '/projects', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(typeof res.json.error).toBe('string');
    }
    expect(store.projects.list()).toEqual([]);

    const { shop } = seed();
    expect((await call('POST', '/projects', { name: 'shop' })).status).toBe(409);
    expect((await call('PATCH', `/projects/${shop.id}`, { name: 'blog' })).status).toBe(409);
    expect((await call('PATCH', `/projects/${shop.id}`, {})).status).toBe(400);
    expect((await call('PATCH', `/projects/${shop.id}`, { autoMerge: 1 })).status).toBe(400);
    expect((await call('PATCH', `/projects/${shop.id}`, { createdAt: 'x' })).status).toBe(400);
    expect((await call('PATCH', '/projects/999', { autoMerge: true })).status).toBe(404);
    expect((await call('PATCH', '/projects/abc', { autoMerge: true })).status).toBe(400);
    // Removing a repo an open PR still uses is refused by the store.
    expect((await call('PATCH', `/projects/${shop.id}`, { repos: [] })).status).toBe(400);
    expect(store.projects.require(shop.id).autoMerge).toBe(false);
  });
});

describe('folder projects', () => {
  let root: string;
  let home: string;
  let worktrees: string;
  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'loop-api-folder-')));
    home = join(root, 'home');
    worktrees = join(home, 'wt');
    for (const d of [join(home, 'resume', 'old'), join(home, 'notes'), join(worktrees, 's1')])
      mkdirSync(d, { recursive: true });
    await server.close();
    server = createServer({
      config,
      store,
      timers: new FakeTimers(clock),
      modules: [dashboardApi({ protectedRoots: [worktrees], home })],
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates a folder project with its canonical path; kind and folderPath never change', async () => {
    symlinkSync(join(home, 'resume'), join(home, 'cv'));
    const created = await call('POST', '/projects', {
      name: 'resume',
      kind: 'folder',
      folderPath: join(home, 'cv'),
      markedForDirectInput: true,
      permissionMode: 'acceptEdits',
      autoMerge: true,
    });
    expect(created.status).toBe(201);
    expect(created.json.project).toMatchObject({
      name: 'resume',
      kind: 'folder',
      folderPath: join(home, 'resume'),
      repos: [],
      envFiles: [],
      autoMerge: true,
      markedForDirectInput: true,
      permissionMode: 'acceptEdits',
    });
    const id = created.json.project.id as number;
    expect((await call('GET', '/projects')).json.projects[0]).toMatchObject({ kind: 'folder' });
    expect((await call('GET', '/tree')).json.projects[0]).toMatchObject({ kind: 'folder' });
    for (const patch of [{ kind: 'git' }, { folderPath: join(home, 'notes') }]) {
      const res = await call('PATCH', `/projects/${id}`, patch);
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/cannot be changed/);
    }
    expect((await call('PATCH', `/projects/${id}`, { repos: [repo] })).json.error).toMatch(/no repos/);
    expect((await call('PATCH', `/projects/${id}`, { permissionMode: 'bypassPermissions' })).status).toBe(
      400,
    );
    expect((await call('PATCH', `/projects/${id}`, { autoMerge: false })).json.project.autoMerge).toBe(false);
    expect(store.projects.require(id)).toMatchObject({ kind: 'folder', folderPath: join(home, 'resume') });
    // A git project still defaults to kind git.
    expect((await call('POST', '/projects', { name: 'shop', repos: [repo] })).json.project).toMatchObject({
      kind: 'git',
      folderPath: null,
    });
  });

  it('rejects invalid folder projects', async () => {
    store.projects.create({ name: 'taken', kind: 'folder', folderPath: join(home, 'resume') });
    mkdirSync(join(home, 'repo', '.git'), { recursive: true });
    symlinkSync(home, join(root, 'home-link'));
    const folder = (folderPath: string, extra: object = {}) => ({
      name: 'p',
      kind: 'folder',
      folderPath,
      ...extra,
    });
    const bad: [unknown, RegExp][] = [
      [{ name: 'p', kind: 'folder' }, /folderPath/],
      [folder('relative/x'), /absolute/],
      [folder(join(home, 'missing')), /does not exist/],
      [folder('/'), /root folder/],
      [folder(home), /home folder/],
      [folder(join(root, 'home-link')), /home folder/],
      [folder(join(worktrees, 's1')), /overlaps/],
      [folder(join(home, 'resume')), /overlaps project "taken"/],
      [folder(join(home, 'resume', 'old')), /overlaps project "taken"/],
      [folder(join(home, 'repo')), /git repository.*allowGitFolder/],
      [folder(join(home, 'notes'), { repos: [repo] }), /repos/],
      [folder(join(home, 'notes'), { envFiles: [] }), /envFiles/],
      [folder(join(home, 'notes'), { permissionMode: 'bypassPermissions' }), /only be set locally/],
      [folder(join(home, 'notes'), { allowGitFolder: 'yes' }), /allowGitFolder/],
      [{ name: 'p', kind: 'svn' }, /kind/],
      [{ name: 'p', kind: 'git', folderPath: join(home, 'notes') }, /folderPath/],
    ];
    for (const [body, error] of bad) {
      const res = await call('POST', '/projects', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.error, JSON.stringify(body)).toMatch(error);
    }
    expect((await call('POST', '/projects', folder(join(home, 'notes'), { name: 'taken' }))).status).toBe(
      409,
    );
    expect(store.projects.list().map((p) => p.name)).toEqual(['taken']);
    const git = await call('POST', '/projects', folder(join(home, 'repo'), { allowGitFolder: true }));
    expect(git.status).toBe(201);
    expect(git.json.project).toMatchObject({ kind: 'folder', folderPath: join(home, 'repo') });
  });

  it('protects credentials, the server repo, git work trees, "#" paths and case variants', async () => {
    for (const d of ['.ssh/keys', '.claude/x', 'Library/Mail', 'repo2/.git', 'repo2/docs', 'a#b'])
      mkdirSync(join(home, d), { recursive: true });
    const folder = (folderPath: string) => ({ name: 'p', kind: 'folder', folderPath });
    const bad: [string, RegExp][] = [
      [join(home, '.ssh'), /credentials/],
      [join(home, '.ssh', 'keys'), /credentials/],
      [join(home, '.claude', 'x'), /agent settings/],
      [join(home, 'Library', 'Mail'), /credentials/],
      [join(REPO_ROOT, 'packages'), /loop server/],
      [join(home, 'repo2', 'docs'), /inside the git repository/],
      [join(home, 'a#b'), /may not contain "#"/],
    ];
    if (caseInsensitive) bad.push([worktrees.toUpperCase(), /overlaps/], [home.toUpperCase(), /home folder/]);
    mkdirSync(join(root, 'outside'));
    bad.push([join(root, 'outside'), /outside your home folder/]);
    for (const [path, error] of bad) {
      const res = await call('POST', '/projects', folder(path));
      expect(res.status, path).toBe(400);
      expect(res.json.error, path).toMatch(error);
    }
    expect(store.projects.list()).toEqual([]);
  });

  it('keeps git repos off folder projects, on create and on PATCH', async () => {
    await call('POST', '/projects', { name: 'notes', kind: 'folder', folderPath: join(home, 'notes') });
    const at = (path: string) => [{ ...repo, path }];
    const created = await call('POST', '/projects', { name: 'shop', repos: at(join(home, 'notes', 'web')) });
    expect(created.status).toBe(400);
    expect(created.json.error).toMatch(/overlaps the folder of project "notes"/);
    const shop = await call('POST', '/projects', { name: 'shop', repos: at(join(home, 'code')) });
    expect(shop.status).toBe(201);
    const moved = await call('PATCH', `/projects/${shop.json.project.id as number}`, { repos: at(home) });
    expect(moved.status).toBe(400);
    expect(moved.json.error).toMatch(/overlaps the folder/);
  });
});

describe('ending a session', () => {
  let folder: string;
  let h: ReturnType<typeof runnerHarness>;
  beforeEach(async () => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'loop-api-end-')));
    h = runnerHarness();
    h.fs.dirs.add(folder);
    h.fs.files.set(join(folder, 'cv.md'), { content: '# CV\n' });
    await server.close();
    store.close();
    store = h.store;
    server = createServer({
      config,
      store,
      timers: new FakeTimers(clock),
      runner: () => h.runner,
      usageMonitor: false,
      modules: [dashboardApi({ protectedRoots: [] })],
    });
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('ends a folder session without touching its files; git sessions keep the uncommitted-changes refusal', async () => {
    const notes = store.projects.create({ name: 'notes', kind: 'folder', folderPath: folder });
    const s = await h.runner.startSession(notes.id, { text: 'Update my CV' });
    const before = new Map([...h.fs.files].filter(([p]) => p.startsWith(folder)));
    const ended = await call('POST', `/sessions/${s.id}/end`, {});
    expect(ended.status).toBe(200);
    expect(ended.json.session).toMatchObject({ id: s.id, status: 'ended' });
    expect(new Map([...h.fs.files].filter(([p]) => p.startsWith(folder)))).toEqual(before);
    expect(h.tmux.windows.size).toBe(0);
    // The folder is free again.
    await expect(h.runner.startSession(notes.id, { text: 'Next' })).resolves.toMatchObject({
      status: 'active',
    });

    const g = await h.runner.startSession(h.shop.id, { text: 'Add login' });
    h.git.statuses.set(g.worktrees[0]!.path, ' M app.ts');
    const refused = await call('POST', `/sessions/${g.id}/end`, {});
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/uncommitted changes/);
    expect(store.sessions.require(g.id).status).toBe('active');
    expect((await call('POST', `/sessions/${g.id}/end`, { force: 'yes' })).status).toBe(400);
    expect((await call('POST', `/sessions/${g.id}/end`, { force: true })).json.session.status).toBe('ended');
    expect((await call('POST', '/sessions/999/end', {})).status).toBe(404);
  });

  it('refuses without a runner (503) and for the reserved router session (409)', async () => {
    const routerSession = ensureRouterSession(store);
    expect((await call('POST', `/sessions/${routerSession.id}/end`, {})).status).toBe(409);
    const imported = store.sessions.importEnded({
      projectId: h.shop.id,
      title: 'past',
      model: 'opus',
      agentSessionId: 'abc-1',
      createdAt: '2026-09-01T09:00:00.000Z',
      endedAt: '2026-09-01T10:00:00.000Z',
    });
    const refused = await call('POST', `/sessions/${imported!.id}/end`, {});
    expect(refused).toEqual({
      status: 409,
      json: { error: 'an imported past conversation has already ended' },
    });
    await server.close();
    server = createServer({ config, store, timers: new FakeTimers(clock), modules: [dashboardApi()] });
    const s = store.sessions.create({ projectId: h.shop.id, title: 't', model: 'opus', branch: 'b' });
    expect((await call('POST', `/sessions/${s.id}/end`, {})).status).toBe(503);
  });
});

describe('deleting a project', () => {
  it('is refused while a session is not ended or a PR is open', async () => {
    const { shop, s1, s2, pr } = seed();
    const res = await call('DELETE', `/projects/${shop.id}`);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe(
      `project ${shop.id} still has 2 session(s) not ended (${s2.id}, ${s1.id}) and 1 open PR(s) (web#42); end them first`,
    );
    expect(store.projects.get(shop.id)).toBeDefined();
    expect(store.questions.listPending()).toHaveLength(1);

    store.sessions.end(s1.id);
    store.sessions.end(s2.id);
    expect((await call('DELETE', `/projects/${shop.id}`)).json.error).toMatch(/1 open PR\(s\) \(web#42\)/);
    store.pullRequests.update(pr.id, { stage: 'escalated', outcome: 'escalated' });
    expect(await call('DELETE', `/projects/${shop.id}`)).toEqual({ status: 200, json: { deleted: true } });
    expect(store.projects.get(shop.id)).toBeUndefined();
  });
});

describe('tree', () => {
  it('nests sessions and subagents under projects with pending question counts', async () => {
    const { s1, s2, sub } = seed();
    const { json } = await call('GET', '/tree');
    const shop = json.projects.find((p: { name: string }) => p.name === 'shop');
    expect(json.projects.map((p: { name: string }) => p.name)).toEqual(['blog', 'shop']);
    expect(shop.sessions.map((s: { title: string }) => s.title)).toEqual(['old', 'search', 'checkout']);
    const checkout = shop.sessions.find((s: { id: number }) => s.id === s1.id);
    expect(checkout).toMatchObject({ provider: 'claude', model: 'opus', pendingQuestions: 1 });
    expect(checkout.subagents).toEqual([expect.objectContaining({ id: sub.id, effort: 'high' })]);
    expect(shop.sessions.find((s: { id: number }) => s.id === s2.id)).toMatchObject({
      status: 'paused',
      pauseReason: 'usage_limit',
      provider: 'opencode',
      pendingQuestions: 0,
    });

    const open = await call('GET', '/tree?status=active,paused');
    expect(open.json.projects[1].sessions).toHaveLength(2);
    expect((await call('GET', '/tree?status=sleeping')).status).toBe(400);
  });

  it('lists imported sessions as ended with source "import", and 150 sessions in a fixed number of queries', async () => {
    const { blog, sub, s1 } = seed();
    for (let i = 0; i < 150; i++) {
      store.sessions.importEnded({
        projectId: blog.id,
        title: `past ${i}`,
        model: 'claude-opus-4-1',
        agentSessionId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        createdAt: '2026-09-01T09:00:00.000Z',
        endedAt: '2026-09-01T10:00:00.000Z',
      });
    }
    const statements: string[] = [];
    const db = (store as unknown as { history: { db: { prepare: (sql: string) => unknown } } }).history.db;
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      statements.push(sql);
      return prepare(sql);
    };
    const { json } = await call('GET', '/tree');
    db.prepare = prepare;
    // Sessions, subagents, pending questions, projects and the router lookups; not one per session.
    expect(statements.length).toBeGreaterThan(2);
    expect(statements.length).toBeLessThan(15);
    expect(statements.filter((sql) => sql.includes('FROM subagents'))).toHaveLength(1);
    const blogTree = json.projects.find((p: { name: string }) => p.name === 'blog');
    expect(blogTree.sessions).toHaveLength(150);
    expect(blogTree.sessions[0]).toMatchObject({
      status: 'ended',
      source: 'import',
      branch: '',
      worktrees: [],
      tmuxTarget: null,
      endedAt: '2026-09-01T10:00:00.000Z',
      subagents: [],
    });
    const shop = json.projects.find((p: { name: string }) => p.name === 'shop');
    expect(shop.sessions.find((s: { id: number }) => s.id === s1.id).subagents).toEqual([
      expect.objectContaining({ id: sub.id }),
    ]);
    expect(shop.sessions.every((s: { source: string }) => s.source === 'runner')).toBe(true);
  });
});

describe('the rigor dial', () => {
  it("sets a session's rigor, shows it in the tree, and records the change once", async () => {
    const { s1 } = seed();
    expect(store.sessions.require(s1.id).rigor).toBe('standard');
    const res = await call('PATCH', `/sessions/${s1.id}`, { rigor: 'thorough' });
    expect(res.status).toBe(200);
    expect(res.json.session).toMatchObject({ id: s1.id, rigor: 'thorough' });
    const { json } = await call('GET', '/tree');
    const shop = json.projects.find((p: { name: string }) => p.name === 'shop');
    expect(shop.sessions.find((s: { id: number }) => s.id === s1.id).rigor).toBe('thorough');
    expect(shop.sessions.filter((s: { rigor: string }) => s.rigor === 'standard')).toHaveLength(2);
    // Setting the same level again changes nothing.
    expect((await call('PATCH', `/sessions/${s1.id}`, { rigor: 'thorough' })).status).toBe(200);
    expect(store.history.list({ sessionId: s1.id }).map((e) => e.text)).toEqual([
      `Session ${s1.id}: the human set its rigor from standard to thorough (dashboard).`,
    ]);
  });

  it('refuses an unknown level, other fields, an unknown session and the reserved router session', async () => {
    const { s1 } = seed();
    expect((await call('PATCH', `/sessions/${s1.id}`, { rigor: 'reckless' })).status).toBe(400);
    expect((await call('PATCH', `/sessions/${s1.id}`, { rigor: 'fast', title: 'x' })).status).toBe(400);
    expect((await call('PATCH', `/sessions/${s1.id}`, {})).status).toBe(400);
    expect((await call('PATCH', `/sessions/${s1.id}`, 'not json')).status).toBe(400);
    expect((await call('PATCH', '/sessions/999', { rigor: 'fast' })).status).toBe(404);
    const routerSession = ensureRouterSession(store);
    expect((await call('PATCH', `/sessions/${routerSession.id}`, { rigor: 'fast' })).status).toBe(409);
    expect(store.sessions.require(s1.id).rigor).toBe('standard');
  });
});

describe('session transcripts', () => {
  it("sends a finished session's latest stored transcript, redacted on read", async () => {
    const { s1, ended, shop } = seed();
    store.history.add({
      projectId: shop.id,
      sessionId: ended.id,
      kind: 'transcript',
      text: 'User: fix exports\nAgent: done, the key sk_test_projectsecret9 was wrong',
    });
    const res = await call('GET', `/sessions/${ended.id}/transcript`);
    expect(res.status).toBe(200);
    expect(res.json.transcript).toMatchObject({ createdAt: expect.any(String) });
    expect(res.json.transcript.text).toContain('User: fix exports');
    expect(res.json.transcript.text).not.toContain('sk_test_projectsecret9');
    // A live session without a stored transcript: null, not an error.
    expect((await call('GET', `/sessions/${s1.id}/transcript`)).json.transcript).toBeNull();
  });

  it('rejects unknown sessions and wrong tokens', async () => {
    seed();
    expect((await call('GET', '/sessions/999/transcript')).status).toBe(404);
    expect((await call('GET', '/sessions/nope/transcript')).status).toBe(400);
    expect((await call('GET', '/sessions/1/transcript', undefined, null)).status).toBe(401);
  });
});

describe('requests', () => {
  it('lists newest first and creates tasks for a project', async () => {
    const { shop, blog, request } = seed();
    const withProject = await call('POST', '/requests', { text: '  Add dark mode ', projectId: shop.id });
    expect(withProject.status).toBe(201);
    expect(withProject.json.request).toMatchObject({
      text: 'Add dark mode',
      projectId: shop.id,
      source: 'dashboard',
      sessionId: null,
    });
    await call('POST', '/requests', { text: 'RSS', projectId: blog.id });
    const all = await call('GET', '/requests');
    expect(all.json.requests.map((r: { text: string }) => r.text)).toEqual([
      'RSS',
      'Add dark mode',
      request.text,
    ]);
    expect((await call('GET', `/requests?projectId=${shop.id}`)).json.requests).toHaveLength(2);
  });

  it('creates tasks without a project for the router to place, and announces every task', async () => {
    seed();
    const events: { type: string }[] = [];
    server.ctx.bus.onAny((e) => {
      events.push(e);
    });
    const unrouted = await call('POST', '/requests', { text: 'Fix flaky CI' });
    expect(unrouted.status).toBe(201);
    expect(unrouted.json.request).toMatchObject({ projectId: null, source: 'dashboard' });
    expect((await call('POST', '/requests', { text: 'x', projectId: null })).status).toBe(201);
    expect((await call('GET', '/requests?projectId=none')).json.requests).toHaveLength(2);
    // Through ctx.requests: the router hears about dashboard tasks.
    expect(events.filter((e) => e.type === 'request.created')).toHaveLength(2);
  });

  it('rejects invalid requests', async () => {
    seed();
    for (const body of [
      {},
      { text: '' },
      { text: '  ' },
      { text: 'x'.repeat(4001) },
      { text: 'x', projectId: 'shop' },
      { text: 'x', projectId: 0 },
      { text: 'x', source: 'telegram' },
      { text: 'x', sessionId: 'checkout' },
      { text: 'x', sessionId: 0 },
    ]) {
      expect((await call('POST', '/requests', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call('POST', '/requests', { text: 'x', projectId: 999 })).status).toBe(404);
    expect((await call('GET', '/requests?projectId=-1')).status).toBe(400);
  });

  it('addresses a task to one open session (the "+" on a session), taking its project', async () => {
    const { shop, blog, s1, s2, ended } = seed();
    const events: { type: string }[] = [];
    server.ctx.bus.onAny((e) => {
      events.push(e);
    });
    const res = await call('POST', '/requests', { text: 'Also handle refunds', sessionId: s1.id });
    expect(res.status).toBe(201);
    expect(res.json.request).toMatchObject({
      text: 'Also handle refunds',
      projectId: shop.id,
      targetSessionId: s1.id,
      sessionId: null, // set by the router once delivered
      source: 'dashboard',
    });
    expect(events.filter((e) => e.type === 'request.created')).toHaveLength(1);
    // A paused session can take one too: the router resumes it with the message.
    expect(
      (await call('POST', '/requests', { text: 'x', sessionId: s2.id, projectId: shop.id })).status,
    ).toBe(201);

    expect((await call('POST', '/requests', { text: 'x', sessionId: ended.id })).status).toBe(409);
    expect(
      (await call('POST', '/requests', { text: 'x', sessionId: s1.id, projectId: blog.id })).status,
    ).toBe(400);
    expect((await call('POST', '/requests', { text: 'x', sessionId: 999 })).status).toBe(404);
  });
});

describe('pull requests and metrics', () => {
  it('lists PRs with stage, round, request and metrics, most recently moved first', async () => {
    const { pr, pr2, request } = seed();
    const { json } = await call('GET', '/prs');
    expect(json.pullRequests.map((p: { id: number }) => p.id)).toEqual([pr2.id, pr.id]);
    expect(json.pullRequests[1]).toMatchObject({
      number: 42,
      stage: 'tests',
      round: 0,
      request: { id: request.id, text: 'Add Apple Pay' },
      metrics: { costUsd: 1.25, tokensIn: 1000, tokensOut: 200, failures: 1, rounds: 0 },
    });
    expect(json.pullRequests[0]).toMatchObject({ stage: 'deployed', round: 2, request: null });

    expect((await call('GET', '/prs?open=true')).json.pullRequests).toHaveLength(1);
    expect((await call('GET', '/prs?stage=deployed,merge')).json.pullRequests).toHaveLength(1);
    expect((await call('GET', '/prs?stage=shipping')).status).toBe(400);
    expect((await call('GET', '/prs?open=maybe')).status).toBe(400);
    expect((await call('GET', `/prs/${pr.id}`)).json.pullRequest.request.text).toBe('Add Apple Pay');
    expect((await call('GET', '/prs/999')).status).toBe(404);
    expect((await call('GET', `/prs/${pr2.id}/metrics`)).json.metrics).toMatchObject({
      rounds: 2,
      costUsd: 0,
    });
  });

  it('totals metrics', async () => {
    const { shop, blog } = seed();
    const { json } = await call('GET', '/metrics');
    expect(json.totals).toEqual({
      costUsd: 1.25,
      tokensIn: 1000,
      tokensOut: 200,
      rounds: 2,
      failures: 1,
      prs: 2,
    });
    expect((await call('GET', `/metrics?projectId=${shop.id}`)).json.metrics).toHaveLength(2);
    expect((await call('GET', `/metrics?projectId=${blog.id}`)).json.totals.prs).toBe(0);
  });
});

describe('settings', () => {
  it('reads and updates', async () => {
    expect((await call('GET', '/settings')).json.settings).toEqual({
      sessionModel: 'opus',
      fallbackModel: 'opencode/glm-5.3-flash-free',
      telegramAllowlist: [],
      claudeEnabled: true,
      opencodeEnabled: true,
      opencodeBackupModels: expect.any(Array),
      dashboardLayout: {},
    });
    const res = await call('PATCH', '/settings', {
      sessionModel: 'claude-opus-5-5',
      fallbackModel: ' opencode/other ',
      telegramAllowlist: [123, 456, 123],
      claudeEnabled: false,
    });
    expect(res.json.settings).toEqual({
      sessionModel: 'claude-opus-5-5',
      fallbackModel: 'opencode/other',
      telegramAllowlist: [123, 456],
      claudeEnabled: false,
      opencodeEnabled: true,
      opencodeBackupModels: expect.any(Array),
      dashboardLayout: {},
    });
    const layout = { topbar: ['brand', 'weekly'], hiddenProjects: [3] };
    expect(
      (await call('PATCH', '/settings', { dashboardLayout: layout })).json.settings.dashboardLayout,
    ).toEqual(layout);
    // The last CLI on cannot be switched off.
    expect((await call('PATCH', '/settings', { opencodeEnabled: false })).status).toBe(400);
  });

  it('rejects invalid updates and changes nothing', async () => {
    for (const body of [
      {},
      { fallbackModel: '' },
      { fallbackModel: 'x'.repeat(201) },
      { telegramAllowlist: ['123'] },
      { telegramAllowlist: [1.5] },
      { telegramAllowlist: [-4] },
      { telegramAllowlist: 123 },
      { telegramAllowlist: Array.from({ length: 201 }, (_, i) => i + 1) },
      { sessionModel: '' },
      { permissionMode: 'auto' },
      { sessionModel: 'x', unknown: 1 },
      { dashboardLayout: [] },
      { dashboardLayout: 'x' },
      { dashboardLayout: { notes: 'x'.repeat(5000) } },
    ]) {
      expect((await call('PATCH', '/settings', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(store.settings.get()).toMatchObject({ sessionModel: 'opus' });
  });
});
