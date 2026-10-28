import type { BusEvent } from '@loop-engineering/ask-human';
import { FakeClock, openStore, sessionToken, type Store } from '@loop-engineering/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { StageLibrary } from '@loop-engineering/loop';
import type { SessionRunner } from '@loop-engineering/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../config.js';
import { createServer, type LoopServer } from '../server.js';
import { dashboardApi } from './dashboard-api.js';
import { MODELS_REASON_MAX, PLAN_MAX, plannerModule, RIGOR_REASON_MAX, SUBMIT_PLAN_TOOL } from './planner.js';

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
let relaunched: [number, string][];

beforeEach(() => {
  clock = new FakeClock('2026-10-26T09:00:00.000Z');
  store = openStore({ clock });
  const shop = store.projects.create({ name: 'shop' }).id;
  mine = store.sessions.create({ projectId: shop, title: 'login', model: 'opus', branch: 'loop/login' }).id;
  other = store.sessions.create({ projectId: shop, title: 'cart', model: 'opus', branch: 'loop/cart' }).id;
  const calls: [number, string][] = (relaunched = []);
  const runner = {
    protectedRoots: () => [],
    relaunch: (id: number, why: string) => {
      calls.push([id, why]);
      return Promise.resolve(store.sessions.require(id));
    },
  } as unknown as SessionRunner;
  const stages = {
    pipeline: () => ({ checks: ['tests', 'security', 'review', 'qa'], deploy: false, guardian: false }),
  } as unknown as StageLibrary;
  server = createServer({
    config,
    store,
    runner: () => runner,
    usageMonitor: false,
    modules: [dashboardApi(), plannerModule({ stages, relaunchDelayMs: 0 })],
  });
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

  it('sets the rigor level and its reason; a plan without a level leaves it alone', async () => {
    const client = await mcpClient(mine);
    const res = await client.callTool({
      name: SUBMIT_PLAN_TOOL,
      arguments: { plan: 'Fix the typo.', rigor: 'fast', rigorReason: '  One word in the footer.  ' },
    });
    expect(res.isError).toBeFalsy();
    expect(store.sessions.require(mine)).toMatchObject({
      rigor: 'fast',
      rigorSource: 'planner',
      rigorReason: 'One word in the footer.',
    });
    expect(events.at(-1)).toEqual({ type: 'session.planned', session: store.sessions.require(mine) });
    expect(store.history.list({ sessionId: mine }).map((e) => e.text)).toEqual([
      `Planner chose fast: One word in the footer. for session ${mine}'s rigor.`,
    ]);
    await client.callTool({ name: SUBMIT_PLAN_TOOL, arguments: { plan: 'next task' } });
    expect(store.sessions.require(mine)).toMatchObject({ rigor: 'fast', rigorSource: 'planner' });
    // A pick without a reason stores none, not an empty string.
    await client.callTool({ name: SUBMIT_PLAN_TOOL, arguments: { plan: 'p3', rigor: 'light' } });
    expect(store.sessions.require(mine)).toMatchObject({ rigor: 'light', rigorReason: null });
  });

  it('refuses an invalid level or a too long reason, and stores nothing', async () => {
    const client = await mcpClient(mine);
    for (const args of [
      { plan: 'p', rigor: 'reckless', rigorReason: 'x' },
      { plan: 'p', rigor: 'fast', rigorReason: 'x'.repeat(RIGOR_REASON_MAX + 1) },
    ]) {
      expect((await client.callTool({ name: SUBMIT_PLAN_TOOL, arguments: args })).isError).toBe(true);
    }
    expect(store.sessions.require(mine)).toMatchObject({
      plan: null,
      rigor: 'standard',
      rigorSource: 'default',
    });
    expect(events).toEqual([]);
  });

  it("never overrides the human's level, and says so; a human change after the Planner's pick sticks", async () => {
    const client = await mcpClient(mine);
    await client.callTool({
      name: SUBMIT_PLAN_TOOL,
      arguments: { plan: 'p1', rigor: 'light', rigorReason: 'small' },
    });
    store.sessions.update(mine, { rigor: 'thorough' }); // the dial
    const res = await client.callTool({
      name: SUBMIT_PLAN_TOOL,
      arguments: { plan: 'p2', rigor: 'fast', rigorReason: 'tiny' },
    });
    expect(text(res)).toBe('Plan recorded. The human chose rigor thorough; it stays. Now build it.');
    expect(store.sessions.require(mine)).toMatchObject({
      plan: 'p2',
      rigor: 'thorough',
      rigorSource: 'human',
      rigorReason: null,
    });
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

  describe('models', () => {
    it("stores the Planner's model per agent with its reason, tells the dashboard and logs the pick", async () => {
      const client = await mcpClient(mine);
      const res = await client.callTool({
        name: SUBMIT_PLAN_TOOL,
        arguments: {
          plan: 'Rework the payment webhook.',
          models: { builder: 'opus', tests: 'haiku', review: 'claude-opus-4-8', security: 'sonnet' },
          modelsReason: '  Payments: strong builder and reviewer.  ',
        },
      });
      expect(res.isError).toBeFalsy();
      expect(text(res)).toBe('Plan recorded. Now build it.');
      expect(store.sessions.require(mine)).toMatchObject({
        models: {
          builder: { model: 'opus', by: 'planner' },
          tests: { model: 'haiku', by: 'planner' },
          review: { model: 'claude-opus-4-8', by: 'planner' },
          security: { model: 'sonnet', by: 'planner' },
        },
        modelsReason: 'Payments: strong builder and reviewer.',
      });
      expect(events.at(-1)).toEqual({ type: 'session.planned', session: store.sessions.require(mine) });
      expect(store.history.list({ sessionId: mine }).map((e) => e.text)).toEqual([
        `Planner chose models for session ${mine}: builder opus, tests haiku, review claude-opus-4-8, security sonnet: Payments: strong builder and reviewer..`,
      ]);
    });

    it('a later plan picks again for the new task; one without models leaves them alone', async () => {
      const client = await mcpClient(mine);
      await client.callTool({
        name: SUBMIT_PLAN_TOOL,
        arguments: { plan: 'p1', models: { review: 'opus' } },
      });
      await client.callTool({ name: SUBMIT_PLAN_TOOL, arguments: { plan: 'p2' } });
      expect(store.sessions.require(mine).models).toEqual({ review: { model: 'opus', by: 'planner' } });
      await client.callTool({
        name: SUBMIT_PLAN_TOOL,
        arguments: { plan: 'p3', models: { tests: 'haiku' } },
      });
      expect(store.sessions.require(mine).models).toEqual({ tests: { model: 'haiku', by: 'planner' } });
    });

    it('refuses names that are not model names, and stores nothing', async () => {
      const client = await mcpClient(mine);
      const bad = [
        { builder: '--dangerously-skip-permissions' },
        { builder: '-opus' },
        { review: 'opus sonnet' },
        { review: 'opus;rm -rf /' },
        { review: '$(id)' },
        { review: '' },
        { review: 'a'.repeat(81) },
      ];
      for (const models of bad) {
        const res = await client.callTool({ name: SUBMIT_PLAN_TOOL, arguments: { plan: 'p', models } });
        expect(res.isError, JSON.stringify(models)).toBe(true);
      }
      const long = await client.callTool({
        name: SUBMIT_PLAN_TOOL,
        arguments: { plan: 'p', models: { review: 'opus' }, modelsReason: 'x'.repeat(MODELS_REASON_MAX + 1) },
      });
      expect(long.isError).toBe(true);
      expect(store.sessions.require(mine)).toMatchObject({ plan: null, models: {}, modelsReason: null });
      expect(events).toEqual([]);
    });

    it('ignores agents that are not in the pipeline, and says so', async () => {
      const client = await mcpClient(mine);
      const res = await client.callTool({
        name: SUBMIT_PLAN_TOOL,
        arguments: { plan: 'p', models: { review: 'sonnet', deploy: 'opus', lint: 'haiku' } },
      });
      expect(res.isError).toBeFalsy();
      expect(text(res)).toBe('Plan recorded. Ignored unknown agents: deploy, lint. Now build it.');
      expect(store.sessions.require(mine).models).toEqual({ review: { model: 'sonnet', by: 'planner' } });
    });

    it('ignores malformed agent ids, "constructor" included, and names them; the rest still applies', async () => {
      const client = await mcpClient(mine);
      const res = await client.callTool({
        name: SUBMIT_PLAN_TOOL,
        arguments: {
          plan: 'p',
          models: { review: 'sonnet', 'Bad Agent': 'opus', constructor: 'opus', '-x': 'opus' },
        },
      });
      expect(res.isError).toBeFalsy();
      expect(text(res)).toBe(
        'Plan recorded. Ignored unknown agents: Bad Agent, constructor, -x. Now build it.',
      );
      expect(store.sessions.require(mine).models).toEqual({ review: { model: 'sonnet', by: 'planner' } });
    });

    it("never overrides the human's choice for an agent, and says so; the others still apply", async () => {
      const client = await mcpClient(mine);
      store.sessions.setAgentModel(mine, 'review', 'haiku'); // the dashboard
      const res = await client.callTool({
        name: SUBMIT_PLAN_TOOL,
        arguments: { plan: 'p', models: { review: 'opus', tests: 'sonnet' }, modelsReason: 'risky' },
      });
      expect(text(res)).toBe('Plan recorded. The human chose the model for review; it stays. Now build it.');
      expect(store.sessions.require(mine).models).toEqual({
        review: { model: 'haiku', by: 'human' },
        tests: { model: 'sonnet', by: 'planner' },
      });
    });

    it('relaunches the live builder when the plan changes its model or effort, and only then', async () => {
      const client = await mcpClient(mine);
      await client.callTool({ name: SUBMIT_PLAN_TOOL, arguments: { plan: 'p', models: { review: 'opus' } } });
      await client.callTool({ name: SUBMIT_PLAN_TOOL, arguments: { plan: 'p', rigor: 'standard' } });
      await new Promise((r) => setTimeout(r, 20));
      expect(relaunched).toEqual([]); // a check's model is not the builder's
      await client.callTool({
        name: SUBMIT_PLAN_TOOL,
        arguments: { plan: 'p', models: { builder: 'sonnet' } },
      });
      await vi.waitFor(() => expect(relaunched.map(([id]) => id)).toEqual([mine]));
      expect(relaunched[0]?.[1]).toMatch(/new model or effort/);
      // The same pick again changes nothing; a new effort does.
      await client.callTool({
        name: SUBMIT_PLAN_TOOL,
        arguments: { plan: 'p', models: { builder: 'sonnet' } },
      });
      await client.callTool({ name: SUBMIT_PLAN_TOOL, arguments: { plan: 'p', rigor: 'fast' } });
      await vi.waitFor(() => expect(relaunched).toHaveLength(2));
    });

    describe('with a delay before the relaunch', () => {
      const slow = async () => {
        await server.close();
        server = createServer({
          config,
          store,
          runner: () =>
            ({
              protectedRoots: () => [],
              relaunch: (id: number, why: string) => {
                relaunched.push([id, why]);
                return Promise.resolve(store.sessions.require(id));
              },
            }) as unknown as SessionRunner,
          usageMonitor: false,
          modules: [dashboardApi(), plannerModule({ relaunchDelayMs: 150 })],
        });
      };

      it('two plans in a row make one relaunch: the later one replaces the pending timer', async () => {
        await slow();
        const client = await mcpClient(mine);
        await client.callTool({
          name: SUBMIT_PLAN_TOOL,
          arguments: { plan: 'p', models: { builder: 'sonnet' } },
        });
        await client.callTool({
          name: SUBMIT_PLAN_TOOL,
          arguments: { plan: 'p', models: { builder: 'haiku' } },
        });
        await new Promise((r) => setTimeout(r, 400));
        expect(relaunched).toHaveLength(1);
      });

      it('a pending relaunch is dropped when the server shuts down, or the session is gone', async () => {
        await slow();
        const client = await mcpClient(mine);
        await client.callTool({
          name: SUBMIT_PLAN_TOOL,
          arguments: { plan: 'p', models: { builder: 'sonnet' } },
        });
        await server.close();
        await new Promise((r) => setTimeout(r, 300));
        expect(relaunched).toEqual([]);
      });
    });

    it('does not relaunch a paused session or one on OpenCode: the pick applies at its next resume', async () => {
      const client = await mcpClient(mine);
      store.sessions.update(mine, { status: 'paused' });
      await client.callTool({
        name: SUBMIT_PLAN_TOOL,
        arguments: { plan: 'p', models: { builder: 'sonnet' } },
      });
      store.sessions.update(mine, { status: 'active', provider: 'opencode' });
      await client.callTool({
        name: SUBMIT_PLAN_TOOL,
        arguments: { plan: 'p', models: { builder: 'haiku' } },
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(relaunched).toEqual([]);
      expect(store.sessions.require(mine).models.builder).toEqual({ model: 'haiku', by: 'planner' });
    });
  });
});
