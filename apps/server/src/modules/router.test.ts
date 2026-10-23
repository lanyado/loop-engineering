import { FakeTimers } from '@loop-engineering/ask-human';
import { FakeClock, openStore, type Question, type Store } from '@loop-engineering/core';
import {
  FakeClassifier,
  FakeMessenger,
  fakeStartSession,
  deliverySentence,
  ensureRouterSession,
  ROUTER_PROJECT_NAME,
} from '@loop-engineering/router';
import type { SessionRunner } from '@loop-engineering/runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The runner's own test harness: a real SessionRunner on fake tmux, git and fs.
import { harness as runnerHarness } from '../../../../packages/runner/src/test-support/harness.js';
import type { ServerConfig } from '../config.js';
import { createServer, type LoopServer } from '../server.js';
import { dashboardApi } from './dashboard-api.js';
import { routerModule, type RouterModuleOptions } from './router.js';

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
let clock: FakeClock;
let server: LoopServer;
let url: string;
let classifier: FakeClassifier;
let startSession: ReturnType<typeof fakeStartSession>;
/** Stands in for the shared SessionRunner on ctx.runner (startSession, deliverFile). */
let runner: FakeMessenger & { startSession: typeof startSession };
let logs: string[];

async function boot(options: RouterModuleOptions = {}, withRunner = true) {
  const router = routerModule({ classifier, log: (m) => logs.push(m), ...options });
  server = createServer({
    config,
    store,
    timers: new FakeTimers(clock),
    modules: [dashboardApi(), router],
    ...(withRunner ? { runner: () => runner as unknown as SessionRunner, usageMonitor: false } : {}),
  });
  ({ url } = await server.start());
}

beforeEach(async () => {
  clock = new FakeClock('2026-10-18T09:00:00.000Z');
  store = openStore({ clock });
  classifier = new FakeClassifier();
  startSession = fakeStartSession(store);
  // FakeMessenger has the runner's deliverFile(sessionId, name, content, sentence) shape.
  runner = Object.assign(new FakeMessenger(), { startSession });
  logs = [];
  await boot();
});
afterEach(async () => {
  await server.close();
  store.close();
});

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: T }> {
  const res = await fetch(`${url}/api${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: res.status, json: (await res.json()) as T };
}

async function until(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('router module', () => {
  it('routes a request from ctx.requests.create after the human answers the routing question over REST', async () => {
    const shop = store.projects.create({ name: 'shop', markedForDirectInput: true });
    const blog = store.projects.create({ name: 'blog', markedForDirectInput: true });
    const login = store.sessions.create({
      projectId: shop.id,
      title: 'fix login',
      model: 'opus',
      branch: 'b1',
    });
    classifier.answer = {
      projectId: shop.id,
      target: { kind: 'session', sessionId: login.id },
      confidence: 0.4,
      candidates: [{ projectId: blog.id, target: { kind: 'new' }, confidence: 0.3 }],
    };

    const request = server.ctx.requests.create({ text: 'Make the logo bigger', source: 'telegram' });

    let pending: Question[] = [];
    await until(async () => {
      pending = (await api<{ questions: Question[] }>('/questions?status=pending')).json.questions;
      return pending.length === 1;
    }, 'the routing question');
    const [question] = pending;
    expect(question?.text).toMatch(new RegExp(`^Route request #${request.id}: `));
    expect(question?.options).toEqual([
      `shop: session 'fix login' (#${login.id})`,
      'blog: new session',
      'shop: new session',
      'Cancel',
    ]);

    const answered = await api<{ accepted: boolean }>(`/questions/${question!.id}/answer`, {
      method: 'POST',
      body: { answer: `shop: session 'fix login' (#${login.id})` },
    });
    expect(answered).toMatchObject({ status: 200, json: { accepted: true } });

    await until(() => store.requests.require(request.id).sessionId !== null, 'routing');
    expect(store.requests.require(request.id)).toMatchObject({ projectId: shop.id, sessionId: login.id });
    // ctx.runner.deliverFile got the text as file content; the agent only gets the fixed sentence.
    const name = `request-${request.id}.md`;
    expect(runner.delivered.map(({ sessionId, name, sentence }) => ({ sessionId, name, sentence }))).toEqual([
      { sessionId: login.id, name, sentence: deliverySentence(name) },
    ]);
    expect(runner.delivered[0]?.content).toContain('Make the logo bigger');
    expect(runner.delivered[0]?.sentence).not.toContain('logo');
    expect(startSession.started).toEqual([]);
    expect(store.history.search('logo', { projectId: shop.id })[0]?.kind).toBe('decision');
  });

  it('gives a dashboard task that names its project a new session there', async () => {
    const shop = store.projects.create({ name: 'shop' });
    const created = await api<{ request: { id: number } }>('/requests', {
      method: 'POST',
      body: { text: 'Add a footer', projectId: shop.id },
    });
    expect(created.status).toBe(201);
    await until(() => store.requests.require(created.json.request.id).sessionId !== null, 'routing');
    expect(startSession.started.map((s) => s.projectId)).toEqual([shop.id]);
    expect(classifier.inputs).toEqual([]);
  });

  it('routes requests stored before the server started', async () => {
    await server.close();
    const shop = store.projects.create({ name: 'shop', markedForDirectInput: true });
    const early = store.requests.create({ text: 'Sent while the server was down', source: 'telegram' });
    classifier.answer = { projectId: shop.id, target: { kind: 'new' }, confidence: 0.9, candidates: [] };
    await boot();
    await until(() => store.requests.require(early.id).sessionId !== null, 'routing');
    expect(store.requests.require(early.id).projectId).toBe(shop.id);
    expect(store.projects.getByName(ROUTER_PROJECT_NAME)).toBeUndefined(); // only made when a question is asked
  });

  it('prefers injected startSession and messenger over ctx.runner', async () => {
    await server.close();
    const shop = store.projects.create({ name: 'shop', markedForDirectInput: true });
    const login = store.sessions.create({
      projectId: shop.id,
      title: 'fix login',
      model: 'opus',
      branch: 'b1',
    });
    classifier.answer = {
      projectId: shop.id,
      target: { kind: 'session', sessionId: login.id },
      confidence: 0.9,
      candidates: [],
    };
    const messenger = new FakeMessenger();
    await boot({ messenger });
    const request = server.ctx.requests.create({ text: 'More login work', source: 'telegram' });
    await until(() => store.requests.require(request.id).sessionId !== null, 'routing');
    expect(messenger.delivered.map((m) => m.sessionId)).toEqual([login.id]);
    expect(runner.delivered).toEqual([]);
  });

  it('hides the reserved project from the dashboard and refuses tasks, edits and deletes for it', async () => {
    store.projects.create({ name: 'shop' });
    const reserved = ensureRouterSession(store);
    const projects = await api<{ projects: { id: number }[] }>('/projects');
    expect(projects.json.projects.map((p) => p.id)).not.toContain(reserved.projectId);
    const tree = await api<{ projects: { id: number }[] }>('/tree');
    expect(tree.json.projects.map((p) => p.id)).not.toContain(reserved.projectId);

    const task = await api('/requests', {
      method: 'POST',
      body: { text: 'Sneaky', projectId: reserved.projectId },
    });
    expect(task.status).toBe(400);
    expect(store.requests.list()).toEqual([]);
    expect((await api(`/projects/${reserved.projectId}`, { method: 'DELETE' })).status).toBe(409);
    expect(
      (
        await api(`/projects/${reserved.projectId}`, {
          method: 'PATCH',
          body: { markedForDirectInput: true },
        })
      ).status,
    ).toBe(409);
    expect(store.projects.get(reserved.projectId)?.markedForDirectInput).toBe(false);
  });

  it('stays off without a runner, leaving requests for a later start', async () => {
    await server.close();
    store.projects.create({ name: 'shop', markedForDirectInput: true });
    await boot({}, false);
    const request = server.ctx.requests.create({ text: 'Queued', source: 'telegram' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.requests.require(request.id)).toMatchObject({ projectId: null, sessionId: null });
    expect(classifier.inputs).toEqual([]);
    expect(logs.join('\n')).toContain('[router] disabled: no session runner');
  });
});

describe('router module on a real SessionRunner (fake tmux, git and fs)', () => {
  it("starts a session for a loop fix request, then delivers a follow-up inside the agent's folder", async () => {
    await server.close();
    store.close();
    const h = runnerHarness();
    store = h.store;
    store.projects.update(h.shop.id, { markedForDirectInput: true });
    const timers = new FakeTimers(new FakeClock('2026-10-18T09:00:00.000Z'));
    server = createServer({
      config,
      store,
      timers,
      runner: () => h.runner,
      usageMonitor: false,
      modules: [routerModule({ classifier, log: (m) => logs.push(m) })],
    });
    await server.start();
    expect(server.ctx.runner).toBe(h.runner);

    // What the PR loop records after a failed deploy: a request that names its project.
    const fix = server.ctx.requests.create({
      text: '[loop] Fix deploy failure of web#3',
      source: 'dashboard',
      projectId: h.shop.id,
    });
    await until(() => store.requests.require(fix.id).sessionId !== null, 'the fix session');
    const session = store.sessions.require(store.requests.require(fix.id).sessionId!);
    expect(session).toMatchObject({ projectId: h.shop.id, status: 'active' });
    expect(classifier.inputs).toEqual([]);
    expect(store.sessions.list({ projectId: h.shop.id }).map((s) => s.id)).toEqual([session.id]);

    classifier.answer = {
      projectId: h.shop.id,
      target: { kind: 'session', sessionId: session.id },
      confidence: 0.9,
      candidates: [],
    };
    const follow = server.ctx.requests.create({ text: 'Also bump the cache TTL', source: 'telegram' });
    await until(() => store.requests.require(follow.id).sessionId === session.id, 'delivery');

    const cwd = session.worktrees[0]!.path;
    const name = `request-${follow.id}.md`;
    expect(h.fs.read(`${cwd}/.loop/${name}`)).toContain('Also bump the cache TTL');
    const keys = h.window(session.tmuxTarget).keys;
    expect(keys).toContain(deliverySentence(name));
    expect(keys).not.toContain('cache TTL');
  });

  it('a folder project keeps working after its first task: deliver, resume, reconcile-end, fresh start (real runner)', async () => {
    await server.close();
    store.close();
    const h = runnerHarness();
    store = h.store;
    const folder = '/home/me/resume';
    h.fs.dirs.add(folder);
    h.fs.files.set(`${folder}/cv.md`, { content: '# CV\n' });
    const resume = store.projects.create({ name: 'resume', kind: 'folder', folderPath: folder });
    server = createServer({
      config,
      store,
      timers: new FakeTimers(new FakeClock('2026-10-18T09:00:00.000Z')),
      runner: () => h.runner,
      usageMonitor: false,
      modules: [routerModule({ classifier, log: (m) => logs.push(m) })],
    });
    await server.start();
    const ask = (text: string) =>
      server.ctx.requests.create({ text, source: 'dashboard', projectId: resume.id });
    const sessionOf = async (id: number) => {
      await until(() => store.requests.require(id).sessionId !== null, `request ${id} routed`);
      return store.sessions.require(store.requests.require(id).sessionId!);
    };

    const first = await sessionOf(ask('Update my resume').id);
    expect(first).toMatchObject({ status: 'active', worktrees: [] });

    // The agent is still running: the next task goes into it, no second agent in the folder.
    const second = ask('Also fix the dates');
    expect((await sessionOf(second.id)).id).toBe(first.id);
    expect(h.fs.read(`${folder}/.loop/request-${second.id}.md`)).toContain('Also fix the dates');
    expect(h.window(first.tmuxTarget).keys).toContain(deliverySentence(`request-${second.id}.md`));

    // Paused by hand: the router asks first (never undoes a manual pause), then resumes as answered,
    // with the request named in the first prompt.
    await h.runner.pause(first.id, 'manual');
    const third = ask('Shorten the summary');
    await until(() => store.questions.listPending().length === 1, 'the manual-pause question');
    const [q] = store.questions.listPending();
    expect(q!.options).toEqual(['Resume it and deliver', 'End it and start fresh', 'Cancel']);
    expect(q!.recommendedOption).toBe('Cancel');
    expect(store.sessions.require(first.id).status).toBe('paused');
    server.ctx.questions.answer(q!.id, 'Resume it and deliver', 'dashboard');
    expect((await sessionOf(third.id)).id).toBe(first.id);
    const resumed = store.sessions.require(first.id);
    expect(resumed.status).toBe('active');
    expect(h.script(h.window(resumed.tmuxTarget))).toContain(`.loop/request-${third.id}.md`);

    // The agent exits: reconcile ends the session (files untouched), and the next task starts fresh.
    h.window(resumed.tmuxTarget).dead = true;
    expect((await h.runner.reconcile()).map((x) => x.status)).toEqual(['ended']);
    expect(h.fs.read(`${folder}/cv.md`)).toBe('# CV\n');
    const fourth = await sessionOf(ask('Add the new job').id);
    expect(fourth.id).not.toBe(first.id);
    expect(fourth.status).toBe('active');
    expect(store.sessions.list({ projectId: resume.id, status: ['active', 'paused'] })).toHaveLength(1);
  });
});
