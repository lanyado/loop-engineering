import { FakeTimers } from '@loop-engineering/ask-human';
import { FakeClock, openStore, sessionToken, type Store } from '@loop-engineering/core';
import { mockUser, MockTelegram, type TelegramConfig } from '@loop-engineering/telegram';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../config.js';
import { createServer, type LoopServer } from '../server.js';
import { telegramModule } from './telegram.js';

const MCP_TOKEN = 'mcp-token-for-tests-00000000001';
const OWNER = mockUser(111, 'Rotem');

const serverConfig: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  dbPath: ':memory:',
  dashboardToken: 'dashboard-token-for-tests-0001',
  mcpToken: MCP_TOKEN,
  corsOrigins: [],
  publicUrl: null,
};

const telegramConfig = (extra: Partial<TelegramConfig> = {}): TelegramConfig => ({
  token: '123:x',
  ownerId: OWNER.id,
  timeZone: 'UTC',
  ...extra,
});

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function boot(
  telegram: Parameters<typeof telegramModule>[0]['telegram'],
  before?: (store: Store, clock: FakeClock, sessionId: number) => void,
) {
  const tg = new MockTelegram();
  const clock = new FakeClock('2026-10-18T09:00:00.000Z');
  const store: Store = openStore({ clock });
  const project = store.projects.create({ name: 'shop' });
  const session = store.sessions.create({
    projectId: project.id,
    title: 'Fix checkout',
    model: 'opus',
    branch: 'b',
  });
  before?.(store, clock, session.id);
  const logs: string[] = [];
  const module = telegramModule({ telegram, transport: tg, log: (m) => logs.push(m) });
  const server: LoopServer = createServer({
    config: serverConfig,
    store,
    timers: new FakeTimers(clock),
    modules: [module],
  });
  const { url } = await server.start();
  cleanup.push(async () => {
    await server.close();
    store.close();
  });
  return { server, store, tg, url, logs, sessionId: session.id, module };
}

describe('telegram server module', () => {
  it('answers ask_human from a real MCP client with a Telegram button tap', async () => {
    const { tg, url, sessionId, logs } = await boot({ enabled: true, config: telegramConfig() });
    expect(logs).toContain('[telegram] bot started (long polling)');
    expect(tg.polling).toBe(true);

    const client = new Client({ name: 'test-agent', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${sessionToken(MCP_TOKEN, sessionId)}`,
          'X-Loop-Session-Id': String(sessionId),
        },
      },
    });
    await client.connect(transport);
    cleanup.push(() => client.close());

    const call = client.callTool(
      {
        name: 'ask_human',
        arguments: { question: 'Which database?', options: ['SQLite', 'Postgres'], recommended: 'SQLite' },
      },
      { timeout: 30_000 },
    );
    const message = await vi.waitFor(() => {
      const sent = tg.sentTo(OWNER.id).find((m) => m.keyboard.length > 0);
      expect(sent).toBeDefined();
      return sent!;
    });
    expect(message.text).toContain('Which database?');

    const tap = await tg.tap(OWNER, message, 'Postgres');
    const result = await call;
    expect(result.structuredContent).toMatchObject({
      answer: 'Postgres',
      answeredVia: 'telegram',
      defaulted: false,
    });
    expect(tg.answerFor(tap)).toBe('answered: Postgres');
    await vi.waitFor(() => expect(message.keyboard).toEqual([]));
    expect(message.text).toContain('Answered: Postgres (via telegram, by Rotem)');
  });

  it('announces questions that came due while the server was down', async () => {
    let questionId = 0;
    const { tg, store } = await boot(
      { enabled: true, config: telegramConfig() },
      (store, clock, sessionId) => {
        questionId = store.questions.create({
          sessionId,
          text: 'Which database?',
          options: ['SQLite', 'Postgres'],
          recommendedOption: 'SQLite',
        }).id;
        clock.advance(20 * 60_000); // the server was down past the deadline
      },
    );
    expect(store.questions.require(questionId).status).toBe('defaulted');
    await vi.waitFor(() =>
      expect(tg.sentTo(OWNER.id).map((m) => m.text)).toEqual([
        `Question #${questionId}: no answer in 15 min, went with the recommended option: SQLite`,
      ]),
    );
  });

  it('stays disabled without a token, and the server still runs', async () => {
    const { url, logs, tg } = await boot({ enabled: false, reason: 'TELEGRAM_BOT_TOKEN is not set' });
    expect(logs).toEqual(['[telegram] bot disabled: TELEGRAM_BOT_TOKEN is not set']);
    expect(tg.polling).toBe(false);
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });
});
