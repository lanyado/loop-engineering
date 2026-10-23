import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachChannel,
  FakeTimers,
  type QuestionChannel,
  type QuestionResolvedEvent,
} from '@loop-engineering/ask-human';
import {
  FakeClock,
  openStore,
  QUESTION_TIMEOUT_MS,
  sessionToken,
  type Question,
  type Store,
} from '@loop-engineering/core';
import { Client, StreamableHTTPClientTransport, type ClientOptions } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The runner's own test harness: a real SessionRunner on fake tmux, git and fs.
import { harness as runnerHarness } from '../../../packages/runner/src/test-support/harness.js';
import { trustQuestion } from '@loop-engineering/runner';
import type { ServerConfig } from './config.js';
import type { ServerModule } from './context.js';
import { createServer, type LoopServer } from './server.js';

const DASHBOARD_TOKEN = 'dashboard-token-for-tests-0001';
const MCP_TOKEN = 'mcp-token-for-tests-00000000001';

const config = (dbPath = ':memory:'): ServerConfig => ({
  host: '127.0.0.1',
  port: 0,
  dbPath,
  dashboardToken: DASHBOARD_TOKEN,
  mcpToken: MCP_TOKEN,
  corsOrigins: [],
  publicUrl: null,
});

/** A Telegram stand-in, plugged in the way M4 will: a server module attaching a channel to the bus. */
class FakeTelegram implements QuestionChannel, ServerModule {
  readonly name = 'telegram' as const;
  posted: Question[] = [];
  confirmations: string[] = [];
  won: string[] = [];
  start(ctx: Parameters<NonNullable<ServerModule['start']>>[0]) {
    attachChannel(ctx.bus, this);
  }
  onQuestion(question: Question) {
    this.posted.push(question);
  }
  onResolvedElsewhere(_e: QuestionResolvedEvent, confirmation: string) {
    this.confirmations.push(confirmation);
  }
  onResolvedHere(e: QuestionResolvedEvent) {
    this.won.push(e.answer);
  }
}

let clock: FakeClock;
let timers: FakeTimers;
let store: Store;
let sessionId: number;
let telegram: FakeTelegram;
let server: LoopServer;
let url: string;
let cleanup: (() => Promise<void> | void)[];

async function boot(dbPath?: string) {
  store = openStore({ clock, ...(dbPath ? { path: dbPath } : {}) });
  const project = store.projects.getByName('shop') ?? store.projects.create({ name: 'shop' });
  sessionId = (
    store.sessions.list({ projectId: project.id })[0] ??
    store.sessions.create({ projectId: project.id, title: 's', model: 'opus', branch: 'b' })
  ).id;
  telegram = new FakeTelegram();
  server = createServer({ config: config(dbPath), store, timers, modules: [telegram] });
  ({ url } = await server.start());
  const [s, st] = [server, store];
  cleanup.push(async () => {
    await s.close();
    st.close();
  });
}

beforeEach(async () => {
  clock = new FakeClock('2026-10-18T09:00:00.000Z');
  timers = new FakeTimers(clock);
  cleanup = [];
  await boot();
});
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

const api = (path: string, init: RequestInit & { token?: string | null } = {}) => {
  const { token = DASHBOARD_TOKEN, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (rest.body) headers.set('Content-Type', 'application/json');
  return fetch(`${url}${path}`, { ...rest, headers });
};
const answerViaDashboard = (id: number, answer: string) =>
  api(`/api/questions/${id}/answer`, { method: 'POST', body: JSON.stringify({ answer }) });

/** An agent session: a real MCP client over Streamable HTTP with the MCP token, as Claude Code connects. */
async function connectAgent(
  token: string | null | undefined = undefined,
  options: ClientOptions = {},
  session: string | null = String(sessionId),
) {
  // Default: the session's own token, as the runner gives each agent.
  if (token === undefined) token = session ? sessionToken(MCP_TOKEN, Number(session)) : null;
  const client = new Client({ name: 'test-agent', version: '0.0.0' }, options);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (session) headers['X-Loop-Session-Id'] = session; // as the runner's .mcp.json sets it
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } });
  await client.connect(transport);
  cleanup.push(() => client.close());
  return client;
}

const askHuman = (client: Client, extra: Record<string, unknown> = {}) =>
  client.callTool(
    {
      name: 'ask_human',
      arguments: {
        question: 'Which database?',
        options: ['SQLite', 'Postgres'],
        recommended: 'SQLite',
        ...extra,
      },
    },
    { timeout: 30_000 },
  );

/** Polls the REST API until exactly one question is pending, as the dashboard would. */
async function pendingQuestion(): Promise<Question> {
  let found: Question | undefined;
  await vi.waitFor(async () => {
    const res = await api('/api/questions?status=pending');
    const { questions } = (await res.json()) as { questions: Question[] };
    expect(questions).toHaveLength(1);
    found = questions[0];
  });
  return found!;
}

describe('ask_human end to end', () => {
  it('returns the answer the human gives on the dashboard', async () => {
    const agent = await connectAgent();
    const call = askHuman(agent, { context: 'Single-user app.' });
    const question = await pendingQuestion();
    expect(question).toMatchObject({ text: 'Which database?', context: 'Single-user app.', sessionId });
    expect(telegram.posted.map((q) => q.id)).toEqual([question.id]);

    const res = await answerViaDashboard(question.id, 'Postgres');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true, question: { status: 'answered' } });

    const result = await call;
    expect(result.structuredContent).toEqual({
      questionId: question.id,
      answer: 'Postgres',
      answeredVia: 'dashboard',
      defaulted: false,
      note: 'The human chose "Postgres" (via dashboard).',
    });
    expect(telegram.confirmations).toEqual(['answered: Postgres (via dashboard)']);
    expect(server.ctx.questions.waitingCount).toBe(0);
  });

  it('serves 2026-07-28 clients too', async () => {
    const agent = await connectAgent(undefined, { versionNegotiation: { mode: 'auto' } });
    expect(agent.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const call = askHuman(agent);
    const question = await pendingQuestion();
    await answerViaDashboard(question.id, 'Postgres');
    expect((await call).structuredContent).toMatchObject({ answer: 'Postgres', answeredVia: 'dashboard' });
  });

  it('defaults to the recommended option after 15 minutes', async () => {
    const agent = await connectAgent();
    const call = askHuman(agent);
    const question = await pendingQuestion();

    timers.advance(QUESTION_TIMEOUT_MS - 1000);
    expect(store.questions.require(question.id).status).toBe('pending');
    timers.advance(1000);

    const result = await call;
    expect(result.structuredContent).toMatchObject({
      answer: 'SQLite',
      answeredVia: 'timeout',
      defaulted: true,
    });
    expect((result.structuredContent as { note: string }).note).toContain(
      'you went with your recommended option "SQLite"',
    );
    expect(telegram.confirmations).toEqual(['no answer in 15 min, went with the recommended option: SQLite']);

    const late = await answerViaDashboard(question.id, 'Postgres');
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ accepted: false, question: { status: 'defaulted' } });
  });

  describe('first answer wins across channels', () => {
    it('telegram first: the dashboard answer is refused and the agent gets the telegram answer', async () => {
      const agent = await connectAgent();
      const call = askHuman(agent);
      const question = await pendingQuestion();

      expect(server.ctx.questions.answer(question.id, 'Postgres', 'telegram').accepted).toBe(true);
      const res = await answerViaDashboard(question.id, 'SQLite');
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ question: { answer: 'Postgres', answeredVia: 'telegram' } });

      expect((await call).structuredContent).toMatchObject({ answer: 'Postgres', answeredVia: 'telegram' });
      expect(telegram.won).toEqual(['Postgres']);
      expect(telegram.confirmations).toEqual([]);
    });

    it('dashboard first: telegram is refused and posts the confirmation', async () => {
      const agent = await connectAgent();
      const call = askHuman(agent);
      const question = await pendingQuestion();

      expect((await answerViaDashboard(question.id, 'SQLite')).status).toBe(200);
      expect(server.ctx.questions.answer(question.id, 'Postgres', 'telegram')).toMatchObject({
        accepted: false,
        question: { answer: 'SQLite' },
      });
      expect((await call).structuredContent).toMatchObject({ answer: 'SQLite', answeredVia: 'dashboard' });
      expect(telegram.confirmations).toEqual(['answered: SQLite (via dashboard)']);
    });

    it('a burst of simultaneous answers has exactly one winner', async () => {
      const agent = await connectAgent();
      const call = askHuman(agent);
      const question = await pendingQuestion();

      const responses = await Promise.all([
        ...['A', 'B', 'C', 'D'].map((a) => answerViaDashboard(question.id, a)),
        Promise.resolve().then(() => server.ctx.questions.answer(question.id, 'T', 'telegram')),
      ]);
      const winners = responses.filter((r) => (r instanceof Response ? r.status === 200 : r.accepted));
      expect(winners).toHaveLength(1);
      const final = store.questions.require(question.id);
      expect((await call).structuredContent).toMatchObject({ answer: final.answer });
      expect(telegram.won.length + telegram.confirmations.length).toBe(1);
    });
  });

  it('stops waiting when the agent disconnects, keeping the question pending', async () => {
    const agent = await connectAgent();
    const call = askHuman(agent);
    const question = await pendingQuestion();
    await vi.waitFor(() => expect(server.ctx.questions.waitingCount).toBe(1));
    await agent.close(); // the agent process exits: its HTTP connection closes
    await expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(server.ctx.questions.waitingCount).toBe(0));
    expect(store.questions.require(question.id).status).toBe('pending');
  });

  it('takes the session from X-Loop-Session-Id, and refuses a sessionId argument that disagrees', async () => {
    const other = store.sessions.create({
      projectId: store.sessions.require(sessionId).projectId,
      title: 'o',
      model: 'm',
      branch: 'o',
    });
    const agent = await connectAgent();
    const mismatch = await askHuman(agent, { sessionId: other.id });
    expect(mismatch.isError).toBe(true);
    expect(JSON.stringify(mismatch.content)).toMatch(/does not match this connection's X-Loop-Session-Id/);

    const call = askHuman(agent, { sessionId }); // agreeing is fine
    expect((await pendingQuestion()).sessionId).toBe(sessionId);
    store.questions.listPending().forEach((q) => server.ctx.questions.answer(q.id, 'SQLite', 'dashboard'));
    await call;
  });

  it('refuses a connection without X-Loop-Session-Id, even with a session token', async () => {
    await expect(connectAgent(sessionToken(MCP_TOKEN, sessionId), {}, null)).rejects.toThrow(
      /401|unauthorized/i,
    );
    expect(store.questions.list()).toEqual([]);
  });

  it('refuses a session token used with another session id, and the shared MCP_TOKEN', async () => {
    const other = store.sessions.create({
      projectId: store.sessions.require(sessionId).projectId,
      title: 'b',
      model: 'm',
      branch: 'b',
    });
    // Session A's token cannot ask (or answer) as session B.
    await expect(connectAgent(sessionToken(MCP_TOKEN, sessionId), {}, String(other.id))).rejects.toThrow(
      /401|unauthorized/i,
    );
    await expect(connectAgent(MCP_TOKEN)).rejects.toThrow(/401|unauthorized/i);
    expect(store.questions.list()).toEqual([]);
  });

  it('refuses a valid token for a session that does not exist or has ended', async () => {
    await expect(connectAgent(sessionToken(MCP_TOKEN, 999), {}, '999')).rejects.toThrow(/401|unauthorized/i);
    const ended = store.sessions.create({
      projectId: store.sessions.require(sessionId).projectId,
      title: 'done',
      model: 'm',
      branch: 'done',
      status: 'ended',
    });
    await expect(connectAgent(sessionToken(MCP_TOKEN, ended.id), {}, String(ended.id))).rejects.toThrow(
      /401|unauthorized/i,
    );
  });

  it('asking the same question again after getting the answer reaches the human again', async () => {
    const agent = await connectAgent();
    const first = askHuman(agent);
    const q1 = await pendingQuestion();
    await answerViaDashboard(q1.id, 'Postgres');
    expect((await first).structuredContent).toMatchObject({ questionId: q1.id, answer: 'Postgres' });

    const second = askHuman(agent); // e.g. the same "merge now?" for the next PR
    const q2 = await pendingQuestion();
    expect(q2.id).not.toBe(q1.id);
    expect(telegram.posted.map((q) => q.id)).toEqual([q1.id, q2.id]);
    await answerViaDashboard(q2.id, 'SQLite');
    expect((await second).structuredContent).toMatchObject({ questionId: q2.id, answer: 'SQLite' });
  });

  it('a REST answer after the deadline but before the sweep defaults the question, once', async () => {
    const agent = await connectAgent();
    const call = askHuman(agent);
    const question = await pendingQuestion();
    const resolved: QuestionResolvedEvent[] = [];
    server.ctx.bus.on('question.resolved', (e) => {
      resolved.push(e);
    });

    clock.advance(QUESTION_TIMEOUT_MS); // time passes, but no sweep timer has fired yet
    const late = await answerViaDashboard(question.id, 'Postgres');
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({
      accepted: false,
      question: { status: 'defaulted', answer: 'SQLite' },
    });
    expect((await call).structuredContent).toMatchObject({ answer: 'SQLite', defaulted: true });

    timers.advance(60_000); // the sweep runs now and finds nothing left to announce
    expect(resolved).toHaveLength(1);
    expect(telegram.confirmations).toEqual(['no answer in 15 min, went with the recommended option: SQLite']);
  });

  it('reports a bad question to the agent as a tool error', async () => {
    const agent = await connectAgent();
    const result = await askHuman(agent, { recommended: 'MySQL' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('recommendedOption must be one of the options');
  });
});

describe('restart', () => {
  it('a restarted server still defaults on time, and a re-asking agent re-attaches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-server-'));
    try {
      await cleanup.pop()?.(); // drop the in-memory server from beforeEach
      await boot(join(dir, 'loop.db'));
      const first = await connectAgent();
      const lost = askHuman(first);
      const question = await pendingQuestion();
      timers.advance(5 * 60_000);

      await cleanup.pop()?.(); // client: closed with the server below
      await cleanup.pop()?.(); // server + store: the process goes away
      await expect(lost).rejects.toThrow(); // the waiting caller's connection is lost

      await boot(join(dir, 'loop.db'));
      const again = askHuman(await connectAgent());
      await vi.waitFor(() => expect(server.ctx.questions.waitingCount).toBe(1));
      expect(store.questions.list()).toHaveLength(1); // re-attached, not asked twice
      timers.advance(10 * 60_000);
      expect((await again).structuredContent).toMatchObject({
        questionId: question.id,
        answer: 'SQLite',
        defaulted: true,
      });
    } finally {
      for (const fn of cleanup.splice(0).reverse()) await fn();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('auth', () => {
  it('serves /health without a token', async () => {
    const res = await api('/health', { token: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it.each([
    ['no token', null],
    ['a wrong token', 'not-the-token-0000000000'],
    ['the MCP token', MCP_TOKEN],
  ])('rejects /api with %s', async (_label, token) => {
    for (const path of ['/api/questions?status=pending', '/api/events']) {
      expect((await api(path, { token })).status).toBe(401);
    }
    const answer = await api('/api/questions/1/answer', { token, method: 'POST', body: '{"answer":"x"}' });
    expect(answer.status).toBe(401);
  });

  it('rejects /mcp without the MCP token', async () => {
    await expect(connectAgent(null)).rejects.toThrow(/401|unauthorized/i);
    await expect(connectAgent(DASHBOARD_TOKEN)).rejects.toThrow(/401|unauthorized/i);
    await expect(connectAgent(MCP_TOKEN)).rejects.toThrow(/401|unauthorized/i);
    const raw = await api('/mcp', { token: null, method: 'POST', body: '{}' });
    expect(raw.status).toBe(401);
    expect(store.questions.list()).toEqual([]);
  });
});

describe('CORS', () => {
  it('answers preflight for allowed origins on /api only', async () => {
    await cleanup.pop()?.();
    store = openStore({ clock });
    server = createServer({
      config: { ...config(), corsOrigins: ['https://dash.example.com'] },
      store,
      timers,
    });
    ({ url } = await server.start());
    const [s, st] = [server, store];
    cleanup.push(async () => {
      await s.close();
      st.close();
    });
    const preflight = (path: string, origin: string) =>
      fetch(`${url}${path}`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      });

    const allowed = await preflight('/api/questions/1/answer', 'https://dash.example.com');
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://dash.example.com');
    expect(allowed.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');

    const other = await preflight('/api/questions/1/answer', 'https://evil.example.com');
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    expect(
      (await preflight('/mcp', 'https://dash.example.com')).headers.get('access-control-allow-origin'),
    ).toBeNull();

    const get = await api('/api/questions', { headers: { Origin: 'https://dash.example.com' } });
    expect(get.status).toBe(200);
    expect(get.headers.get('access-control-allow-origin')).toBe('https://dash.example.com');
  });

  it('sends no CORS headers when no origins are configured', async () => {
    const get = await api('/api/questions', { headers: { Origin: 'https://dash.example.com' } });
    expect(get.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('REST API', () => {
  it('lists and filters questions and validates input', async () => {
    const { question: a } = server.ctx.questions.ask({
      sessionId,
      text: 'a?',
      options: ['x'],
      recommendedOption: 'x',
    });
    const { question: b } = server.ctx.questions.ask({
      sessionId,
      text: 'b?',
      options: ['y'],
      recommendedOption: 'y',
    });
    server.ctx.questions.answer(a.id, 'x', 'telegram');
    const ids = async (query: string) =>
      ((await (await api(`/api/questions${query}`)).json()) as { questions: Question[] }).questions.map(
        (q) => q.id,
      );
    expect(await ids('?status=pending')).toEqual([b.id]);
    expect(await ids('?status=answered,pending')).toEqual([b.id, a.id]);
    expect(await ids(`?sessionId=${sessionId}`)).toEqual([b.id, a.id]);
    expect(await ids('')).toEqual([b.id, a.id]);

    expect((await api('/api/questions?status=nope')).status).toBe(400);
    expect(await (await api(`/api/questions/${a.id}`)).json()).toMatchObject({ question: { id: a.id } });
    expect((await api('/api/questions/999')).status).toBe(404);
    expect((await answerViaDashboard(999, 'x')).status).toBe(404);
    expect((await answerViaDashboard(b.id, '  ')).status).toBe(400);
    expect((await answerViaDashboard(b.id, 'x'.repeat(2001))).status).toBe(400);
    const huge = await api(`/api/questions/${b.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer: 'x'.repeat(70_000) }),
    });
    expect(huge.status).toBe(413);
    expect(store.questions.require(b.id).status).toBe('pending');
    expect((await api(`/api/questions/${b.id}/answer`, { method: 'POST', body: 'not json' })).status).toBe(
      400,
    );
    expect((await api('/api/nothing-here')).status).toBe(404);
  });
});

/** Reads an SSE response into {event, data} records. */
function sseReader(res: Response) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: { event: string; data: unknown }[] = [];
  let buffer = '';
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const field = (name: string) =>
          block
            .split('\n')
            .find((l) => l.startsWith(`${name}:`))
            ?.slice(name.length + 1)
            .trim();
        const event = field('event');
        if (event) events.push({ event, data: JSON.parse(field('data') ?? 'null') });
      }
    }
  })().catch(() => {});
  return { events, stop: () => reader.cancel().then(() => pump) };
}

describe('GET /api/events', () => {
  it('streams question.created and question.resolved to the dashboard', async () => {
    const res = await api('/api/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const sse = sseReader(res);
    cleanup.push(() => sse.stop());
    await vi.waitFor(() => expect(sse.events.map((e) => e.event)).toEqual(['ready']));

    const agent = await connectAgent();
    const call = askHuman(agent);
    const question = await pendingQuestion();
    await answerViaDashboard(question.id, 'Postgres');
    await call;

    await vi.waitFor(() => expect(sse.events).toHaveLength(3));
    expect(sse.events[1]).toMatchObject({
      event: 'question.created',
      data: { type: 'question.created', question: { id: question.id } },
    });
    expect(sse.events[2]).toMatchObject({
      event: 'question.resolved',
      data: { type: 'question.resolved', answer: 'Postgres', answeredVia: 'dashboard', defaulted: false },
    });
  });

  it('unsubscribes when the dashboard disconnects', async () => {
    const before = server.ctx.bus.listenerCount;
    const sse = sseReader(await api('/api/events'));
    await vi.waitFor(() => expect(sse.events).toHaveLength(1));
    expect(server.ctx.bus.listenerCount).toBe(before + 1);
    await sse.stop();
    await vi.waitFor(() => expect(server.ctx.bus.listenerCount).toBe(before));
  });
});

describe('runner monitor', () => {
  it("asks the human about a session stuck at Claude's folder-trust prompt, once per launch", async () => {
    const h = runnerHarness();
    const s = await h.runner.startSession(h.shop.id, { text: 'Add a README line' });
    const dialog =
      ' Accessing workspace:\n /wt/x\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel\n';
    h.tmux.print(s.tmuxTarget ?? '', dialog);
    const loop = createServer({
      config: config(),
      store: h.store,
      runner: () => h.runner,
      log: () => undefined,
    });
    try {
      await loop.start();
      await vi.waitFor(() => expect(h.store.questions.listPending()).toHaveLength(1));
      const [q] = h.store.questions.listPending();
      expect(q).toMatchObject({ sessionId: s.id, recommendedOption: 'Later' });
      expect(q?.text).toContain(`Session ${s.id} is waiting at Claude's "Do you trust this folder?" prompt`);
      expect(q?.context).toContain(`tmux attach -t ${s.tmuxTarget ?? ''}`);
      // The dialog is left for the human: nothing was typed into the window.
      expect(h.window(s.tmuxTarget).keys).toBe('');

      // A relaunch that sticks again (new window, later) is a new question: the question service
      // would fold an identical text into the first, undelivered one.
      const ask = (target: string, at: Date) =>
        loop.ctx.questions.ask({ sessionId: s.id, ...trustQuestion(s.id, target, '/wt/x', at) });
      const first = ask('loop:@7', new Date('2026-10-18T09:00:00Z'));
      expect(ask('loop:@7', new Date('2026-10-18T09:00:10Z')).reused).toBe(true);
      expect(ask('loop:@8', new Date('2026-10-18T09:00:10Z')).question.id).not.toBe(first.question.id);
      expect(ask('loop:@7', new Date('2026-10-18T09:30:00Z')).reused).toBe(false);
    } finally {
      await loop.close();
      h.store.close();
    }
  });
});
