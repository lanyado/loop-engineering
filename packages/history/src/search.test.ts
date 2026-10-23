import { createAskHumanMcpHandler, QuestionBus, QuestionService } from '@loop-engineering/ask-human';
import { FakeClock, openStore, type Store } from '@loop-engineering/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  registerSearchHistoryTool,
  SEARCH_HISTORY_TOOL,
  searchHistory,
  sessionTranscript,
} from './search.js';

let store: Store;
let shop: number;
let blog: number;
let shopSession: number;
let blogSession: number;
let clients: Client[];

beforeEach(() => {
  store = openStore({ clock: new FakeClock('2026-10-18T09:00:00Z') });
  shop = store.projects.create({ name: 'shop' }).id;
  blog = store.projects.create({ name: 'blog' }).id;
  shopSession = store.sessions.create({
    projectId: shop,
    title: 'login',
    model: 'opus',
    branch: 'loop/a',
  }).id;
  blogSession = store.sessions.create({
    projectId: blog,
    title: 'posts',
    model: 'opus',
    branch: 'loop/b',
  }).id;
  store.history.add({
    projectId: shop,
    sessionId: shopSession,
    kind: 'transcript',
    text: 'User: add Google login with passport oauth',
  });
  store.history.add({
    projectId: shop,
    kind: 'decision',
    text: 'Decided: passport keeps sessions in the cookie store',
  });
  store.history.add({
    projectId: blog,
    sessionId: blogSession,
    kind: 'transcript',
    text: 'User: passport photos gallery for the blog',
  });
  clients = [];
});
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  store.close();
});

describe('searchHistory', () => {
  it('scopes to a project and filters by kind', async () => {
    expect(
      (await searchHistory(store, { query: 'passport', projectId: shop })).map((r) => r.kind).sort(),
    ).toEqual(['decision', 'transcript']);
    expect(await searchHistory(store, { query: 'passport', projectId: blog })).toHaveLength(1);
    expect(
      (await searchHistory(store, { query: 'passport', projectId: shop, kind: 'decision' }))[0]?.snippet,
    ).toContain('[passport]');
    expect(await searchHistory(store, { query: 'passport' })).toHaveLength(3);
    expect(await searchHistory(store, { query: 'passport', limit: 1 })).toHaveLength(1);
  });

  it('redacts results on read, including decisions other modules wrote', async () => {
    // As the loop might record a failed push: a remote URL with a token in it.
    store.history.add({
      projectId: shop,
      kind: 'decision',
      text: 'Push failed: remote https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/me/shop.git rejected the deploy',
    });
    store.history.add({
      projectId: shop,
      kind: 'decision',
      text: 'Rotated the deploy key to server-secret-value-1',
    });
    store.projects.update(shop, {
      repos: [{ name: 'web', path: '/src/web', remote: 'r', defaultBranch: 'main' }],
      envFiles: [{ repo: 'web', source: '/env/shop.env', target: '.env' }],
    });
    store.history.add({
      projectId: shop,
      kind: 'decision',
      text: 'The deploy used rk_test_projectsecret9 by mistake',
    });
    const results = await searchHistory(
      store,
      { query: 'deploy', projectId: shop },
      {
        secrets: ['server-secret-value-1'],
        readFile: () => Promise.resolve('STRIPE_KEY=rk_test_projectsecret9\n'),
      },
    );
    const all = JSON.stringify(results);
    expect(results).toHaveLength(3);
    expect(all).toContain('https://***@github.com/me/shop.git');
    for (const secret of ['ghp_', 'x-access-token', 'server-secret-value-1', 'rk_test_projectsecret9'])
      expect(all).not.toContain(secret);
    expect(all).toContain('[deploy]');
  });

  it('builds the snippet from the redacted text, so a token is never half-cut at an edge', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    store.history.add({
      projectId: shop,
      kind: 'decision',
      text: `${'x '.repeat(200)}${token} needle ${'y '.repeat(200)}`,
    });
    const [hit] = await searchHistory(store, { query: 'needle', projectId: shop });
    expect(hit?.snippet).toContain('*** [needle]');
    expect(hit?.snippet).not.toMatch(/ghp_|aaaaaa/);
  });
});

describe('sessionTranscript', () => {
  it('returns the latest transcript entry of one session, without a query', async () => {
    store.history.add({
      projectId: shop,
      sessionId: shopSession,
      kind: 'transcript',
      text: 'User: the newer conversation',
    });
    const t = await sessionTranscript(store, shopSession);
    expect(t?.text).toContain('newer conversation');
    expect(t?.createdAt).toBe('2026-10-18T09:00:00.000Z');
    expect(await sessionTranscript(store, blogSession)).toMatchObject({
      text: expect.stringContaining('gallery') as unknown,
    });
    expect(await sessionTranscript(store, 9999)).toBeNull();
  });

  it('redacts the transcript on read, like a search result', async () => {
    store.projects.update(shop, {
      repos: [{ name: 'web', path: '/src/web', remote: 'r', defaultBranch: 'main' }],
      envFiles: [{ repo: 'web', source: '/env/shop.env', target: '.env' }],
    });
    store.history.add({
      projectId: shop,
      sessionId: shopSession,
      kind: 'transcript',
      text: 'User: the key sk_test_projectsecret9 failed',
    });
    const t = await sessionTranscript(store, shopSession, {
      secrets: ['server-secret-value-1'],
      readFile: () => Promise.resolve('STRIPE_KEY=sk_test_projectsecret9\n'),
    });
    expect(t?.text).not.toContain('sk_test_projectsecret9');
    expect(t?.text).toContain('***');
  });
});

/** A real MCP client against the real /mcp handler (ask_human + search_history), in process. */
async function connect(headers: Record<string, string>) {
  const questions = new QuestionService(store, new QuestionBus());
  const handler = createAskHumanMcpHandler(questions, {
    tools: [(server, connection) => registerSearchHistoryTool(server, store, connection)],
  });
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://loop.test/mcp'), {
    fetch: (url, init) => {
      const request = new Request(url, init);
      for (const [k, v] of Object.entries(headers)) request.headers.set(k, v);
      return handler.fetch(request);
    },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

describe('search_history MCP tool', () => {
  it("sits next to ask_human and only returns the caller project's history", async () => {
    const client = await connect({ 'X-Loop-Session-Id': String(shopSession) });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['ask_human', SEARCH_HISTORY_TOOL]);

    const result = await client.callTool({ name: SEARCH_HISTORY_TOOL, arguments: { query: 'passport' } });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as {
      projectId: number;
      results: { kind: string; snippet: string }[];
    };
    expect(out.projectId).toBe(shop);
    expect(out.results).toHaveLength(2);
    expect(out.results.every((r) => !r.snippet.includes('gallery'))).toBe(true);

    const blogClient = await connect({ 'X-Loop-Session-Id': String(blogSession) });
    const blogResult = await blogClient.callTool({
      name: SEARCH_HISTORY_TOOL,
      arguments: { query: 'passport', limit: 5 },
    });
    expect((blogResult.structuredContent as { results: unknown[] }).results).toHaveLength(1);
  });

  it('refuses a connection without the session header or with an unknown session', async () => {
    const anonymous = await connect({});
    const res = await anonymous.callTool({ name: SEARCH_HISTORY_TOOL, arguments: { query: 'passport' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('X-Loop-Session-Id');

    const ghost = await connect({ 'X-Loop-Session-Id': '999' });
    const res2 = await ghost.callTool({ name: SEARCH_HISTORY_TOOL, arguments: { query: 'passport' } });
    expect(res2.isError).toBe(true);
    expect(JSON.stringify(res2.content)).toContain('session 999 does not exist');
  });

  it('rejects an empty query', async () => {
    const client = await connect({ 'X-Loop-Session-Id': String(shopSession) });
    const res = await client.callTool({ name: SEARCH_HISTORY_TOOL, arguments: { query: '  ' } });
    expect(res.isError).toBe(true);
  });
});
