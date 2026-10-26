import type { BusEvent } from '@loop-engineering/ask-human';
import { FakeClock, openStore, sessionToken, type Store } from '@loop-engineering/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../config.js';
import { createServer, type LoopServer } from '../server.js';
import { dashboardApi } from './dashboard-api.js';
import { PLAN_MAX, plannerModule, SUBMIT_PLAN_TOOL } from './planner.js';

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

let clock: FakeClock;
let store: Store;
let server: LoopServer;
let clients: Client[];
let events: BusEvent[];
let mine: number;
let other: number;

beforeEach(() => {
  clock = new FakeClock('2026-10-26T09:00:00.000Z');
  store = openStore({ clock });
  const shop = store.projects.create({ name: 'shop' }).id;
  mine = store.sessions.create({ projectId: shop, title: 'login', model: 'opus', branch: 'loop/login' }).id;
  other = store.sessions.create({ projectId: shop, title: 'cart', model: 'opus', branch: 'loop/cart' }).id;
  server = createServer({ config, store, modules: [dashboardApi(), plannerModule()] });
  events = [];
  server.ctx.bus.onAny((e) => {
    events.push(e);
  });
  clients = [];
});
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await server.close();
  store.close();
});

async function mcpClient(sessionId: number, header: string | null = String(sessionId)) {
  const client = new Client({ name: 'agent', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://loop.test/mcp'), {
    fetch: (url, init) => {
      const request = new Request(url, init);
      request.headers.set('Authorization', `Bearer ${sessionToken(MCP_TOKEN, sessionId)}`);
      if (header !== null) request.headers.set('X-Loop-Session-Id', header);
      return Promise.resolve(server.app.request(request));
    },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const text = (res: Awaited<ReturnType<Client['callTool']>>) =>
  (res.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

describe('submit_plan', () => {
  it("stores the caller's plan, trimmed and stamped, tells the dashboard, and says to build it", async () => {
    const client = await mcpClient(mine);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain(SUBMIT_PLAN_TOOL);

    const res = await client.callTool({
      name: SUBMIT_PLAN_TOOL,
      arguments: { plan: '  Goal: Google login.\nFiles: auth.ts\n' },
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toBe('Plan recorded. Now build it.');
    expect(store.sessions.require(mine)).toMatchObject({
      plan: 'Goal: Google login.\nFiles: auth.ts',
      plannedAt: '2026-10-26T09:00:00.000Z',
    });
    expect(store.sessions.require(other).plan).toBeNull();
    expect(events).toEqual([{ type: 'session.planned', session: store.sessions.require(mine) }]);
  });

  it('a later plan replaces the earlier one', async () => {
    const client = await mcpClient(mine);
    await client.callTool({ name: SUBMIT_PLAN_TOOL, arguments: { plan: 'first task plan' } });
    clock.advance(60_000);
    await client.callTool({ name: SUBMIT_PLAN_TOOL, arguments: { plan: 'second task plan' } });
    expect(store.sessions.require(mine)).toMatchObject({
      plan: 'second task plan',
      plannedAt: '2026-10-26T09:01:00.000Z',
    });
  });

  it('refuses an empty or oversized plan, and stores nothing', async () => {
    const client = await mcpClient(mine);
    for (const plan of ['   ', 'x'.repeat(PLAN_MAX + 1)]) {
      const res = await client.callTool({ name: SUBMIT_PLAN_TOOL, arguments: { plan } });
      expect(res.isError).toBe(true);
    }
    expect(store.sessions.require(mine).plan).toBeNull();
    expect(events).toEqual([]);
  });

  it('plans only for the session of its connection; the arguments cannot name another', async () => {
    const client = await mcpClient(mine);
    const res = await client.callTool({
      name: SUBMIT_PLAN_TOOL,
      arguments: { plan: 'mine', sessionId: other },
    });
    expect(res.isError).toBeFalsy();
    expect(store.sessions.require(other).plan).toBeNull();
    // Another session's id in the header, with this session's token: refused before any tool runs.
    await expect(mcpClient(mine, String(other))).rejects.toThrow(/401|unauthorized/i);
  });

  it('an ended session cannot plan: its token no longer opens /mcp', async () => {
    store.sessions.end(mine);
    await expect(mcpClient(mine)).rejects.toThrow(/401|unauthorized/i);
    expect(store.sessions.require(mine).plan).toBeNull();
  });
});
