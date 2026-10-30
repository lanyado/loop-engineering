import { FakeTimers } from '@loop-engineering/ask-human';
import { FakeClock, openStore, type Store } from '@loop-engineering/core';
import { FileStageLibrary, ProjectStageFiles } from '@loop-engineering/loop';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeUsageModule } from '../../../server/src/modules/claude-usage';
import { dashboardApi } from '../../../server/src/modules/dashboard-api';
import { pipelineModule } from '../../../server/src/modules/pipeline';
import { createServer, type LoopServer } from '../../../server/src/server';
import { BackendError } from './backend';
import { demoData } from './fixtures';
import { HttpBackend } from './http-backend';

// Contract test: the dashboard's client and schemas against the real server routes, in-process
// (app.request instead of a socket). If the server's JSON drifts from schemas.ts, this fails.

const TOKEN = 'dashboard-token-for-tests-0001';
let store: Store;
let server: LoopServer;
let backend: HttpBackend;
let sessionId: number;

const inProcessFetch =
  (s: LoopServer): typeof fetch =>
  (input, init) =>
    Promise.resolve(
      s.app.request(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init),
    );

beforeEach(() => {
  const clock = new FakeClock('2026-10-18T09:00:00.000Z');
  store = openStore({ clock });
  server = createServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      dbPath: ':memory:',
      dashboardToken: TOKEN,
      mcpToken: 'mcp-token-for-tests-00000000001',
      corsOrigins: [],
      publicUrl: null,
    },
    store,
    timers: new FakeTimers(clock),
    modules: [
      dashboardApi(),
      // No stage files: the built-ins (nothing writes here).
      pipelineModule({
        stages: new ProjectStageFiles(new FileStageLibrary('/nonexistent/stages', () => undefined)),
      }),
      // The shape of GET /api/loop/status (apps/server/src/modules/loop.test.ts runs the real route).
      {
        name: 'loop',
        api: (api) =>
          api.get('/loop/status', (c) => c.json({ started: true, offlineSince: '2026-10-18T08:40:00.000Z' })),
      },
      claudeUsageModule({
        file: '/state/usage.json',
        read: () =>
          Promise.resolve(
            JSON.stringify({
              capturedAt: 1792314000,
              rateLimits: { five_hour: { used_percentage: 42, resets_at: 1792324800 } },
            }),
          ),
      }),
    ],
    sseKeepAliveMs: 60_000,
  });
  backend = new HttpBackend({ serverUrl: 'http://loop.test/', token: TOKEN, fetch: inProcessFetch(server) });

  const repo = { name: 'web', path: '/w', remote: 'git@x:w.git', defaultBranch: 'main' };
  const project = store.projects.create({ name: 'shop', repos: [repo] });
  const session = store.sessions.create({
    projectId: project.id,
    title: 'checkout',
    model: 'opus',
    branch: 'b',
  });
  sessionId = session.id;
  store.subagents.create({ sessionId, title: 'tests', model: 'sonnet', effort: 'high' });
  const request = store.requests.create({ projectId: project.id, text: 'Apple Pay', source: 'telegram' });
  const pr = store.pullRequests.create({
    projectId: project.id,
    repo: 'web',
    number: 1,
    url: 'u',
    requestId: request.id,
  });
  store.metrics.record(pr.id, { costUsd: 1, tokensIn: 10, tokensOut: 5, failures: 1 });
});
afterEach(async () => {
  await server.close();
  store.close();
});

const ask = (text = 'Which DB?') =>
  server.ctx.questions.ask({ sessionId, text, options: ['SQLite', 'Postgres'], recommendedOption: 'SQLite' })
    .question;

describe('HttpBackend against the real server', () => {
  it('reads everything the views need', async () => {
    ask();
    expect(await backend.pendingQuestions()).toHaveLength(1);
    const tree = await backend.tree();
    expect(tree[0]?.sessions[0]).toMatchObject({ title: 'checkout', pendingQuestions: 1, effort: null });
    expect(tree[0]?.sessions[0]?.subagents).toHaveLength(1);
    const [pr] = await backend.pullRequests();
    expect(pr).toMatchObject({
      stage: 'tests',
      round: 0,
      request: { text: 'Apple Pay' },
      metrics: { costUsd: 1 },
    });
    expect(await backend.settings()).toMatchObject({ sessionModel: 'opus' });
    expect(pr?.loopState).toEqual({});
    expect(await backend.offlineSince()).toBe('2026-10-18T08:40:00.000Z');
    expect(await backend.usage()).toEqual({
      capturedAt: '2026-10-18T09:00:00.000Z',
      fiveHour: { usedPercentage: 42, resetsAt: '2026-10-18T12:00:00.000Z' },
      sevenDay: null,
    });
  });

  it("reads the pipeline, and the demo's choices (reserved ids, runs) are the server's", async () => {
    const view = await backend.pipeline();
    expect(view.pipeline.checks).toEqual(['tests', 'review', 'qa']);
    const { choices } = demoData(new Date()).pipeline;
    expect([...choices.reserved].sort()).toEqual([...view.choices.reserved].sort());
    expect(choices.runs).toEqual(view.choices.runs);
  });

  it("reads a project's pipeline and where its own folder would be; a Save there goes to that project", async () => {
    const project = store.projects.require(store.sessions.require(sessionId).projectId);
    expect((await backend.pipeline()).projects).toEqual({});
    const view = await backend.pipeline(project.id);
    expect(view.project).toEqual({
      id: project.id,
      own: false,
      dir: `${project.repos[0]!.path}/.loop-engineering`,
    });
    expect(view.pipeline.checks).toEqual(['tests', 'review', 'qa']);
    // The repo's folder is not on this machine: the server says so, and writes nothing.
    const update = { pipeline: { checks: ['review'], deploy: true, guardian: true } };
    await expect(backend.updatePipeline(update, project.id)).rejects.toThrow(/is not there/);
    await expect(backend.pipeline(999)).rejects.toMatchObject({ status: 404 });
  });

  it("reads a session's plan and newest task time, and the Planner's instructions", async () => {
    expect((await backend.tree())[0]?.sessions[0]).toMatchObject({
      plan: null,
      plannedAt: null,
      latestRequestAt: null,
    });
    store.sessions.setPlan(sessionId, 'Goal: Apple Pay.');
    expect((await backend.tree())[0]?.sessions[0]).toMatchObject({
      plan: 'Goal: Apple Pay.',
      plannedAt: '2026-10-18T09:00:00.000Z',
    });
    expect((await backend.pipeline()).planner).toMatchObject({ id: 'planner', builtin: true });
  });

  it("sets a session's rigor and reads it back in the tree; refuses an unknown session", async () => {
    expect((await backend.tree())[0]?.sessions[0]?.rigor).toBe('standard');
    await backend.setRigor(sessionId, 'fast');
    expect((await backend.tree())[0]?.sessions[0]?.rigor).toBe('fast');
    expect(store.sessions.require(sessionId).rigor).toBe('fast');
    await expect(backend.setRigor(9999, 'light')).rejects.toMatchObject({ status: 404 });
  });

  it("reads who set a session's level: the Planner with its reason, then the human", async () => {
    expect((await backend.tree())[0]?.sessions[0]).toMatchObject({
      rigorSource: 'default',
      rigorReason: null,
    });
    store.sessions.setPlan(sessionId, 'Goal: copy.', { rigor: 'fast', reason: 'A copy change.' });
    expect((await backend.tree())[0]?.sessions[0]).toMatchObject({
      rigor: 'fast',
      rigorSource: 'planner',
      rigorReason: 'A copy change.',
    });
    await backend.setRigor(sessionId, 'fast');
    expect((await backend.tree())[0]?.sessions[0]).toMatchObject({ rigorSource: 'human', rigorReason: null });
  });

  it("sets an agent's model and reads it back in the tree with who chose it; clears it; refuses a bad one", async () => {
    expect((await backend.tree())[0]?.sessions[0]).toMatchObject({ models: {}, modelsReason: null });
    store.sessions.setPlan(sessionId, 'plan', undefined, {
      models: { tests: 'haiku' },
      reason: 'easy to check',
    });
    await backend.setAgentModel(sessionId, 'review', 'sonnet');
    expect((await backend.tree())[0]?.sessions[0]).toMatchObject({
      models: { tests: { model: 'haiku', by: 'planner' }, review: { model: 'sonnet', by: 'human' } },
      modelsReason: 'easy to check',
    });
    await backend.setAgentModel(sessionId, 'review', null);
    expect(store.sessions.require(sessionId).models).toEqual({ tests: { model: 'haiku', by: 'planner' } });
    await expect(backend.setAgentModel(sessionId, 'builder', '--effort=max')).rejects.toMatchObject({
      status: 400,
    });
    await expect(backend.setAgentModel(9999, 'builder', 'opus')).rejects.toMatchObject({ status: 404 });
  });

  it("reads a PR's pending loop question and sends a message to one session", async () => {
    const q = ask('Merge it?');
    const [listed] = await backend.pullRequests();
    store.pullRequests.update(listed!.id, {
      stage: 'awaiting_approval',
      loopState: { question: { kind: 'approval', id: q.id, sha: 'abc' }, reviewedSha: 'abc' },
    });
    expect((await backend.pullRequests())[0]?.loopState).toEqual({
      question: { kind: 'approval', id: q.id },
      reviewedSha: 'abc',
    });
    expect(await backend.messageSession(sessionId, 'Also refunds')).toMatchObject({
      targetSessionId: sessionId,
      sessionId: null,
      source: 'dashboard',
    });
    store.sessions.end(sessionId);
    await expect(backend.messageSession(sessionId, 'Too late')).rejects.toMatchObject({ status: 409 });
  });

  it("reads a finished session's stored transcript, or null when none is stored", async () => {
    const projects = store.projects.list();
    const project = projects[0];
    if (!project) throw new Error('no seeded project');
    store.sessions.end(sessionId);
    store.history.add({
      projectId: project.id,
      sessionId,
      kind: 'transcript',
      text: 'User: widen the search box',
    });
    expect(await backend.sessionTranscript(sessionId)).toMatchObject({
      createdAt: '2026-10-18T09:00:00.000Z',
      text: expect.stringContaining('widen the search box') as unknown,
    });
    // An existing session with nothing stored yet: null. An unknown one: 404.
    const fresh = store.sessions.create({
      projectId: project.id,
      title: 'other',
      model: 'opus',
      branch: 'x',
    });
    store.sessions.end(fresh.id);
    expect(await backend.sessionTranscript(fresh.id)).toBeNull();
    await expect(backend.sessionTranscript(9999)).rejects.toMatchObject({ status: 404 });
  });

  it('answers, and reports a question someone else answered first', async () => {
    const q = ask();
    const first = await backend.answer(q.id, 'Postgres');
    expect(first).toMatchObject({
      accepted: true,
      question: { status: 'answered', answeredVia: 'dashboard' },
    });
    const second = await backend.answer(q.id, 'SQLite');
    expect(second).toMatchObject({ accepted: false, question: { answer: 'Postgres' } });
    await expect(backend.answer(999, 'x')).rejects.toMatchObject({ status: 404 });
  });

  it('writes toggles, settings and requests', async () => {
    const [project] = await backend.tree();
    expect(await backend.updateProject(project!.id, { autoMerge: true })).toMatchObject({
      autoMerge: true,
    });
    expect(await backend.updateSettings({ telegramAllowlist: [5, 6], sessionModel: 'sonnet' })).toMatchObject(
      {
        telegramAllowlist: [5, 6],
        sessionModel: 'sonnet',
      },
    );
    expect(await backend.createRequest({ text: 'Dark mode', projectId: project!.id })).toMatchObject({
      projectId: project!.id,
      source: 'dashboard',
    });
    const withFile = await backend.createRequest({
      text: 'See shot',
      projectId: project!.id,
      attachments: [{ name: 'shot.png', data: 'YQ==' }],
    });
    expect(withFile.text).toMatch(/Attached files[^]*shot\.png/);
    await expect(backend.createRequest({ text: 'Anywhere', projectId: 0 })).rejects.toBeInstanceOf(Error);
  });

  it('turns server errors into BackendError with the server message', async () => {
    await expect(backend.updateSettings({ fallbackModel: '' })).rejects.toMatchObject({
      name: 'BackendError',
      status: 400,
    });
    await expect(backend.updateProject(999, { autoMerge: true })).rejects.toMatchObject({
      status: 404,
      message: 'project 999 not found',
    });
    const wrongToken = new HttpBackend({
      serverUrl: 'http://loop.test',
      token: 'wrong-token-wrong',
      fetch: inProcessFetch(server),
    });
    await expect(wrongToken.settings()).rejects.toMatchObject({
      status: 401,
      message: 'the server rejected DASHBOARD_TOKEN',
    });
  });

  it('reports an unreachable server and an unexpected response', async () => {
    const down = new HttpBackend({
      serverUrl: 'http://loop.test',
      token: TOKEN,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(down.tree()).rejects.toBeInstanceOf(BackendError);
    await expect(down.tree()).rejects.toMatchObject({ status: 503 });
    const odd = new HttpBackend({
      serverUrl: 'http://loop.test',
      token: TOKEN,
      fetch: () => Promise.resolve(Response.json({ projects: [{ id: 'x' }] })),
    });
    await expect(odd.tree()).rejects.toMatchObject({ status: 502 });
  });

  it('opens the event stream with the token and relays question events', async () => {
    const abort = new AbortController();
    const res = await backend.events(abort.signal);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: ready')) text += decoder.decode((await reader.read()).value);
    ask('Live?');
    while (!text.includes('question.created')) text += decoder.decode((await reader.read()).value);
    expect(text).toContain('Live?');
    abort.abort();
    await reader.cancel().catch(() => {});
  });
});
