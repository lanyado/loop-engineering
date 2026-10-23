/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any --
   These tests poke at JSON responses. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTimers } from '@loop-engineering/ask-human';
import { FakeClock, openStore, sessionToken, type Store } from '@loop-engineering/core';
import { encodeProjectDir } from '@loop-engineering/history';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../config.js';
import { createServer, type LoopServer } from '../server.js';
import { dashboardApi } from './dashboard-api.js';
import { historyModule } from './history.js';

const DASHBOARD_TOKEN = 'dashboard-token-for-tests-0001';
const MCP_TOKEN = 'mcp-token-for-tests-00000000001';
const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  dbPath: ':memory:',
  dashboardToken: DASHBOARD_TOKEN,
  mcpToken: MCP_TOKEN,
  corsOrigins: [],
  publicUrl: null,
};

let dir: string;
let store: Store;
let timers: FakeTimers;
let server: LoopServer;
let clients: Client[];
let shop: number;
let blog: number;
let shopSession: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'history-module-'));
  const clock = new FakeClock('2026-10-18T09:00:00.000Z');
  store = openStore({ clock });
  timers = new FakeTimers(clock);
  shop = store.projects.create({
    name: 'shop',
    repos: [{ name: 'web', path: '/src/web', remote: 'r', defaultBranch: 'main' }],
  }).id;
  blog = store.projects.create({ name: 'blog' }).id;
  shopSession = store.sessions.create({
    projectId: shop,
    title: 'login',
    model: 'opus',
    branch: 'loop/login',
    status: 'paused',
    agentSessionId: '00000000-0000-4000-8000-0000000000aa',
    worktrees: [{ repo: 'web', path: '/wt/shop/login/web' }],
  }).id;
  const blogSession = store.sessions.create({
    projectId: blog,
    title: 'posts',
    model: 'opus',
    branch: 'loop/posts',
  }).id;
  store.history.add({
    projectId: blog,
    sessionId: blogSession,
    kind: 'decision',
    text: 'Use markdown for posts',
  });
  store.history.add({ projectId: shop, kind: 'decision', text: 'Use passport for Google login' });
  const folder = join(dir, encodeProjectDir('/wt/shop/login/web'));
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, '00000000-0000-4000-8000-0000000000aa.jsonl'),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Add markdown rendering to the login help page' },
    }) + '\n',
  );
  server = createServer({
    config,
    store,
    timers,
    modules: [
      dashboardApi(),
      historyModule({ ingest: { projectsDir: dir, log: () => undefined }, intervalMs: 60_000 }),
    ],
  });
  clients = [];
});
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await server.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function get(path: string, token: string | null = DASHBOARD_TOKEN) {
  const res = await server.app.request(`/api${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const raw = await res.text();
  return {
    status: res.status,
    json: (raw.startsWith('{') ? JSON.parse(raw) : { text: raw }) as Record<string, any>,
  };
}

async function mcpClient(sessionId: number, token = sessionToken(MCP_TOKEN, sessionId)) {
  const client = new Client({ name: 'agent', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://loop.test/mcp'), {
    fetch: (url, init) => {
      const request = new Request(url, init);
      request.headers.set('Authorization', `Bearer ${token}`);
      request.headers.set('X-Loop-Session-Id', String(sessionId));
      return Promise.resolve(server.app.request(request));
    },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

describe('history module', () => {
  it('ingests paused sessions on start and their transcripts become searchable over /mcp', async () => {
    const module = historyModule({ ingest: { projectsDir: dir, log: () => undefined } });
    await module.start?.(server.ctx);
    await vi.waitFor(() =>
      expect(store.history.list({ sessionId: shopSession, kind: 'transcript' })).toHaveLength(1),
    );
    await module.stop?.();

    const client = await mcpClient(shopSession);
    const res = await client.callTool({ name: 'search_history', arguments: { query: 'markdown' } });
    const out = res.structuredContent as { projectId: number; results: { kind: string; snippet: string }[] };
    expect(out.projectId).toBe(shop);
    // The blog project's "markdown" decision is not visible to a shop session.
    expect(out.results.map((r) => r.kind)).toEqual(['transcript']);
    expect(out.results[0]?.snippet).toContain('[markdown]');
  });

  it('sweeps again on the timer', async () => {
    await server.start();
    await vi.waitFor(() => expect(store.history.list({ kind: 'transcript' })).toHaveLength(1));
    const other = store.sessions.create({
      projectId: shop,
      title: 'later',
      model: 'opus',
      branch: 'loop/later',
      status: 'ended',
      agentSessionId: '00000000-0000-4000-8000-0000000000bb',
      worktrees: [{ repo: 'web', path: '/wt/shop/later/web' }],
    });
    writeFileSync(
      join(dir, encodeProjectDir('/wt/shop/login/web'), '00000000-0000-4000-8000-0000000000bb.jsonl'),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      }) + '\n',
    );
    timers.advance(60_000);
    await vi.waitFor(() =>
      expect(store.history.list({ sessionId: other.id, kind: 'transcript' })).toHaveLength(1),
    );
  });
});

describe('search_history isolation (per-session MCP tokens)', () => {
  it("a session cannot read another project's history by forging X-Loop-Session-Id", async () => {
    const blogSession = store.sessions.list({ projectId: blog })[0]!.id;
    // The shop session's token, presented with the blog session's id: refused before any tool runs.
    await expect(mcpClient(blogSession, sessionToken(MCP_TOKEN, shopSession))).rejects.toThrow(
      /401|unauthorized/i,
    );
    // Neither does the shared MCP_TOKEN work by default.
    await expect(mcpClient(blogSession, MCP_TOKEN)).rejects.toThrow(/401|unauthorized/i);
    // With its own token, the shop session only sees shop history.
    const shopClient = await mcpClient(shopSession);
    const res = await shopClient.callTool({ name: 'search_history', arguments: { query: 'markdown' } });
    expect((res.structuredContent as { projectId: number }).projectId).toBe(shop);
    expect(JSON.stringify(res.structuredContent)).not.toContain('posts');
  });

  it('accepts the shared MCP_TOKEN only with MCP_ALLOW_SHARED_TOKEN=on, and warns loudly at start', async () => {
    await server.close();
    const warnings: string[] = [];
    const warned = createServer({
      config: { ...config, allowSharedMcpToken: true },
      store,
      timers,
      log: (m) => warnings.push(m),
    });
    await warned.start();
    await warned.close();
    expect(warnings).toEqual([expect.stringContaining('WARNING: MCP_ALLOW_SHARED_TOKEN=on')]);
    server = createServer({
      config: { ...config, allowSharedMcpToken: true },
      store,
      timers,
      modules: [historyModule()],
    });
    const client = await mcpClient(shopSession, MCP_TOKEN);
    const res = await client.callTool({ name: 'search_history', arguments: { query: 'passport' } });
    expect(res.isError).toBeFalsy();
  });
});

describe('GET /api/history', () => {
  it('searches across projects or within one, best match first', async () => {
    const all = await get('/history?q=use');
    expect(all.status).toBe(200);
    expect(all.json.results).toHaveLength(2);
    const one = await get(`/history?q=use&projectId=${shop}`);
    expect(one.json.results).toEqual([
      expect.objectContaining({
        kind: 'decision',
        sessionId: null,
        snippet: expect.stringContaining('[Use]'),
      }),
    ]);
    expect((await get(`/history?q=use&kind=transcript`)).json.results).toEqual([]);
    expect((await get('/history?q=use&limit=1')).json.results).toHaveLength(1);
  });

  it('redacts a token in a remote URL from a decision another module wrote', async () => {
    store.history.add({
      projectId: shop,
      kind: 'decision',
      text: 'Loop: push to https://oauth2:glpat-abcdefghij0123456789@gitlab.com/me/shop.git failed',
    });
    const res = await get(`/history?q=push&projectId=${shop}`);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.json);
    expect(body).toContain('https://***@gitlab.com/me/shop.git');
    expect(body).not.toMatch(/glpat-|oauth2/);
  });

  it('validates the query and needs the dashboard token', async () => {
    expect((await get('/history')).status).toBe(400);
    expect((await get('/history?q=x&limit=500')).status).toBe(400);
    expect((await get('/history?q=x&kind=nope')).status).toBe(400);
    expect((await get('/history?q=x&projectId=999')).status).toBe(404);
    expect((await get('/history?q=x', null)).status).toBe(401);
    expect((await get('/history?q=x', MCP_TOKEN)).status).toBe(401);
  });
});
