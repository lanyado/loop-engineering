import { QUESTION_TIMEOUT_MS } from '@loop-engineering/core';
import { Client, StreamableHTTPClientTransport, type ClientOptions } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { harness, newQuestion, type Harness } from './testing/harness.js';
import { ASK_HUMAN_TOOL, askHuman, createAskHumanMcpHandler, toAskHumanOutput } from './tool.js';

let h: Harness;
let clients: Client[];
beforeEach(() => {
  h = harness();
  clients = [];
});
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  h.close();
});

/** An MCP client talking to the handler in-process: real protocol, no network. */
/** Sends X-Loop-Session-Id for the harness session unless `headers` is given, as the runner does. */
async function connect(options: ClientOptions = {}, headers?: Record<string, string>) {
  headers ??= { 'X-Loop-Session-Id': String(h.session.id) };
  const handler = createAskHumanMcpHandler(h.service, { timers: h.timers, heartbeatMs: 1000 });
  const client = new Client({ name: 'test-agent', version: '0.0.0' }, options);
  const transport = new StreamableHTTPClientTransport(new URL('http://ask-human.test/mcp'), {
    fetch: (url, init) => {
      const request = new Request(url, init);
      for (const [k, v] of Object.entries(headers ?? {})) request.headers.set(k, v);
      return handler.fetch(request);
    },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const args = (sessionId: number) => ({
  question: 'Which database?',
  options: ['SQLite', 'Postgres'],
  recommended: 'SQLite',
  context: 'Single-user app on one Mac.',
  sessionId,
});

const pendingQuestion = async () => {
  await vi.waitFor(() => expect(h.store.questions.listPending()).toHaveLength(1));
  return h.store.questions.listPending()[0]!;
};

describe('ask_human tool', () => {
  it.each([
    ['2025-era client (no negotiation)', {}, '2025-11-25'],
    ['2026-07-28 client', { versionNegotiation: { mode: 'auto' } } satisfies ClientOptions, '2026-07-28'],
  ])('lists the tool and returns the human answer to a %s', async (_era, options, version) => {
    const client = await connect(options);
    expect(client.getNegotiatedProtocolVersion()).toBe(version);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([ASK_HUMAN_TOOL]);
    expect([...(tools[0]?.inputSchema.required ?? [])].sort()).toEqual([
      'options',
      'question',
      'recommended',
    ]);

    const call = client.callTool({ name: ASK_HUMAN_TOOL, arguments: args(h.session.id) });
    const question = await pendingQuestion();
    expect(question).toMatchObject({ text: 'Which database?', context: 'Single-user app on one Mac.' });
    h.service.answer(question.id, 'Postgres', 'telegram');

    const result = await call;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      questionId: question.id,
      answer: 'Postgres',
      answeredVia: 'telegram',
      defaulted: false,
      note: 'The human chose "Postgres" (via telegram).',
    });
  });

  it('returns the recommended option with a note when the deadline passes', async () => {
    h.sweeper.start();
    const client = await connect();
    const call = client.callTool({ name: ASK_HUMAN_TOOL, arguments: args(h.session.id) });
    await pendingQuestion();
    h.timers.advance(QUESTION_TIMEOUT_MS);
    const result = await call;
    expect(result.structuredContent).toMatchObject({
      answer: 'SQLite',
      answeredVia: 'timeout',
      defaulted: true,
    });
    expect((result.structuredContent as { note: string }).note).toMatch(
      /No answer within 15 minutes, so you went with your recommended option "SQLite"\. Say so in your work/,
    );
  });

  it('sends progress heartbeats while waiting when the client asks for progress', async () => {
    const client = await connect();
    const progress: number[] = [];
    const call = client.callTool(
      { name: ASK_HUMAN_TOOL, arguments: args(h.session.id) },
      { onprogress: (p) => progress.push(p.progress), resetTimeoutOnProgress: true },
    );
    const question = await pendingQuestion();
    h.timers.advance(3000);
    await vi.waitFor(() => expect(progress).toEqual([1, 2, 3]));
    h.service.answer(question.id, 'SQLite', 'dashboard');
    await expect(call).resolves.toMatchObject({ structuredContent: { answer: 'SQLite' } });
    expect(h.timers.pending).toBe(0);
  });

  describe('session id', () => {
    const noSession = () => {
      const withSession: Partial<ReturnType<typeof args>> = args(h.session.id);
      delete withSession.sessionId;
      return withSession;
    };

    it('comes from the X-Loop-Session-Id header when the input has none', async () => {
      const client = await connect({}, { 'X-Loop-Session-Id': String(h.session.id) });
      const call = client.callTool({ name: ASK_HUMAN_TOOL, arguments: noSession() });
      const question = await pendingQuestion();
      expect(question.sessionId).toBe(h.session.id);
      h.service.answer(question.id, 'SQLite', 'dashboard');
      await expect(call).resolves.toMatchObject({ structuredContent: { answer: 'SQLite' } });
    });

    it('is required: a sessionId argument alone is not enough', async () => {
      const bare = await connect({}, {});
      const result = await bare.callTool({ name: ASK_HUMAN_TOOL, arguments: args(h.session.id) });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/no X-Loop-Session-Id header/);
      expect(h.store.questions.list()).toEqual([]);
    });

    it('refuses an input that disagrees with the header, or no session at all', async () => {
      const other = h.store.sessions.create({
        projectId: h.session.projectId,
        title: 'o',
        model: 'm',
        branch: 'o',
      });
      const withHeader = await connect({}, { 'X-Loop-Session-Id': String(h.session.id) });
      const mismatch = await withHeader.callTool({ name: ASK_HUMAN_TOOL, arguments: args(other.id) });
      expect(mismatch.isError).toBe(true);
      expect(JSON.stringify(mismatch.content)).toMatch(/does not match/);

      const bare = await connect({}, {});
      const none = await bare.callTool({ name: ASK_HUMAN_TOOL, arguments: noSession() });
      expect(none.isError).toBe(true);
      expect(JSON.stringify(none.content)).toMatch(/no X-Loop-Session-Id header/);
      expect(h.store.questions.list()).toEqual([]);
    });
  });

  it('trims the recommended option like the options', async () => {
    const client = await connect();
    const call = client.callTool({
      name: ASK_HUMAN_TOOL,
      arguments: { ...args(h.session.id), options: [' SQLite ', 'Postgres'], recommended: 'SQLite ' },
    });
    expect((await pendingQuestion()).recommendedOption).toBe('SQLite');
    h.timers.advance(QUESTION_TIMEOUT_MS);
    h.service.expireDue();
    await expect(call).resolves.toMatchObject({ structuredContent: { answer: 'SQLite', defaulted: true } });
  });

  it('refuses oversized questions before creating them', async () => {
    const client = await connect();
    const result = await client
      .callTool({ name: ASK_HUMAN_TOOL, arguments: { ...args(h.session.id), question: 'x'.repeat(3001) } })
      .catch((error: unknown) => ({ isError: true, content: String(error) }));
    expect(result.isError).toBe(true);
    expect(h.store.questions.list()).toEqual([]);
  });

  it('reports invalid questions as tool errors the agent can fix', async () => {
    const client = await connect();
    const bad = await client.callTool({
      name: ASK_HUMAN_TOOL,
      arguments: { ...args(h.session.id), recommended: 'MySQL' },
    });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toMatch(/recommendedOption must be one of the options/);

    const elsewhere = await connect({}, { 'X-Loop-Session-Id': '999' });
    const unknownSession = await elsewhere.callTool({ name: ASK_HUMAN_TOOL, arguments: args(999) });
    expect(unknownSession.isError).toBe(true);
    expect(JSON.stringify(unknownSession.content)).toMatch(/session 999 not found/);

    const missing = await client
      .callTool({ name: ASK_HUMAN_TOOL, arguments: { question: 'q' } })
      .catch((error: unknown) => ({ isError: true, content: String(error) }));
    expect(missing.isError).toBe(true);
    expect(h.store.questions.list()).toEqual([]);
  });
});

describe('re-asking', () => {
  const input = { ...args(0), sessionId: 0 };
  const ask = (signal?: AbortSignal) => askHuman(h.service, { ...input, sessionId: h.session.id }, signal);

  it('re-attaches once to an outcome the agent missed, then asks the human anew', async () => {
    const controller = new AbortController();
    const lost = ask(controller.signal);
    controller.abort(); // the agent's connection drops while waiting
    await expect(lost).rejects.toThrow();
    const [question] = h.store.questions.listPending();
    h.clock.advance(60_000);
    h.service.answer(question!.id, 'Postgres', 'telegram'); // answered while the agent was away

    const again = await ask();
    expect(again).toMatchObject({ questionId: question!.id, answer: 'Postgres' });
    expect(again.note).toMatch(
      new RegExp(
        `^This is the outcome of your identical question #${question!.id} from .*, settled while you were disconnected`,
      ),
    );

    const third = ask(); // the outcome was delivered now, so this is a new question for the human
    const [fresh] = h.store.questions.listPending();
    expect(fresh?.id).not.toBe(question!.id);
    h.service.answer(fresh!.id, 'SQLite', 'dashboard');
    await expect(third).resolves.toMatchObject({ questionId: fresh!.id, answer: 'SQLite' });
    expect(h.events.filter((e) => e.type === 'question.created')).toHaveLength(2);
  });

  it('asks the human again when the agent already received the answer', async () => {
    const first = ask();
    const [question] = h.store.questions.listPending();
    h.service.answer(question!.id, 'Postgres', 'telegram');
    expect((await first).note).toBe('The human chose "Postgres" (via telegram).');

    const second = ask();
    expect(h.store.questions.listPending()).toHaveLength(1);
    expect(h.store.questions.listPending()[0]!.id).not.toBe(question!.id);
    expect(h.events.filter((e) => e.type === 'question.created')).toHaveLength(2);
    h.service.answer(h.store.questions.listPending()[0]!.id, 'SQLite', 'dashboard');
    await expect(second).resolves.toMatchObject({ answer: 'SQLite' });
  });
});

describe('toAskHumanOutput', () => {
  it('tells the agent to follow a free-text answer', () => {
    const { question } = h.service.ask(newQuestion(h.session.id));
    const answered = h.service.answer(question.id, 'Neither, use DuckDB', 'telegram').question;
    expect(toAskHumanOutput(answered).note).toBe(
      'The human replied via telegram with free text instead of one of the options. Follow it: "Neither, use DuckDB"',
    );
  });
});

describe('extra tools on the ask_human server', () => {
  it('a throwing registrar or one that tries to replace ask_human leaves ask_human working', async () => {
    const errors: Error[] = [];
    const handler = createAskHumanMcpHandler(h.service, {
      timers: h.timers,
      onerror: (e) => errors.push(e),
      tools: [
        () => {
          throw new Error('broken module');
        },
        (server) => server.registerTool(ASK_HUMAN_TOOL, { description: 'impostor' }, () => ({ content: [] })),
        (server) =>
          server.registerTool('ping', { description: 'ping' }, () => ({
            content: [{ type: 'text', text: 'pong' }],
          })),
      ],
    });
    const client = new Client({ name: 'test-agent', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('http://ask-human.test/mcp'), {
      fetch: (url, init) => {
        const request = new Request(url, init);
        request.headers.set('X-Loop-Session-Id', String(h.session.id));
        return handler.fetch(request);
      },
    });
    await client.connect(transport);
    clients.push(client);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([ASK_HUMAN_TOOL, 'ping']);
    expect(tools.find((t) => t.name === ASK_HUMAN_TOOL)?.description).not.toBe('impostor');
    expect(errors.map((e) => e.message)).toEqual(
      expect.arrayContaining(['broken module', `${ASK_HUMAN_TOOL} is reserved`]),
    );
  });
});
