import { FakeTimers } from '@loop-engineering/ask-human';
import { FakeClock, openStore, QUESTION_TIMEOUT_MS, type Store } from '@loop-engineering/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from './config.js';
import type { ServerModule } from './context.js';
import { createServer } from './server.js';

const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  dbPath: ':memory:',
  dashboardToken: 'dashboard-token-for-tests-0001',
  mcpToken: 'mcp-token-for-tests-00000000001',
  corsOrigins: [],
  publicUrl: null,
};

let store: Store | null = null;
afterEach(() => {
  store?.close();
  store = null;
});

function setup(modules: ServerModule[]) {
  const clock = new FakeClock('2026-10-18T09:00:00.000Z');
  const timers = new FakeTimers(clock);
  store = openStore({ clock });
  const project = store.projects.create({ name: 'shop' });
  const session = store.sessions.create({ projectId: project.id, title: 's', model: 'opus', branch: 'b' });
  const logs: string[] = [];
  const server = createServer({
    config,
    store,
    timers,
    modules,
    moduleStartTimeoutMs: 20,
    log: (m) => logs.push(m),
  });
  return { server, timers, logs, sessionId: session.id, store };
}

describe('server start and shutdown with misbehaving modules', () => {
  it('a module whose start never settles does not keep questions from defaulting', async () => {
    let laterStarted = false;
    const stuck: ServerModule = { name: 'stuck', start: () => new Promise<void>(() => {}) };
    const later: ServerModule = {
      name: 'later',
      start: () => {
        laterStarted = true;
      },
    };
    const { server, timers, logs, sessionId, store } = setup([stuck, later]);

    await server.start();
    expect(logs).toEqual(['[server] module stuck still starting after 20 ms; continuing without waiting']);
    expect(laterStarted).toBe(true);
    expect(server.ctx.sweeper.running).toBe(true);

    const { question } = server.ctx.questions.ask({
      sessionId,
      text: 'Which database?',
      options: ['SQLite', 'Postgres'],
      recommendedOption: 'SQLite',
    });
    timers.advance(QUESTION_TIMEOUT_MS);
    expect(store.questions.require(question.id)).toMatchObject({ status: 'defaulted', answer: 'SQLite' });

    await server.close();
  });

  it('a start that fails late is logged, not thrown', async () => {
    let fail: (e: Error) => void = () => {};
    const slow: ServerModule = {
      name: 'slow',
      start: () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    };
    const { server, logs } = setup([slow]);
    await server.start();
    fail(new Error('network down'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(logs).toContain('[server] module slow failed to start: Error: network down');
    await server.close();
  });

  it('a module that fails to stop does not block closing the rest', async () => {
    const stopped: string[] = [];
    const modules: ServerModule[] = [
      { name: 'first', stop: () => void stopped.push('first') },
      {
        name: 'broken',
        stop: () => Promise.reject(new Error('stop failed')),
      },
    ];
    const { server, logs } = setup(modules);
    await server.start();
    await expect(server.close()).resolves.toBeUndefined();
    expect(stopped).toEqual(['first']);
    expect(logs).toEqual(['[server] module broken failed to stop: Error: stop failed']);
    expect(server.ctx.sweeper.running).toBe(false);
  });
});

describe('listening', () => {
  const serve = (host: string, port = 0) => {
    store = openStore({ clock: new FakeClock('2026-10-18T09:00:00.000Z') });
    return createServer({ config: { ...config, host, port }, store, modules: [] });
  };

  it.each(['127.0.0.1', 'localhost', '::1'])('returns the resolved address and port for %s', async (host) => {
    const server = serve(host);
    const bound = await server.start();
    await server.close();
    expect(bound.port).toBeGreaterThan(0);
    expect(bound.address).toMatch(/^(127\.0\.0\.1|::1)$/);
  });

  it('rejects start() with EADDRNOTAVAIL for an address this machine lacks', async () => {
    await expect(serve('192.0.2.1').start()).rejects.toMatchObject({ code: 'EADDRNOTAVAIL' });
  });

  it('rejects start() with EADDRINUSE when the port is taken', async () => {
    const first = serve('127.0.0.1');
    const { port } = await first.start();
    await expect(serve('127.0.0.1', port).start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await first.close();
  });
});
