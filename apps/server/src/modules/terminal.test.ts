import { FakeClock, openStore, type Store } from '@loop-engineering/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../config.js';
import { createServer, type LoopServer } from '../server.js';
import { terminalModule } from './terminal.js';

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
let server: LoopServer;
let opened: string[];

beforeEach(() => {
  store = openStore({ clock: new FakeClock('2026-10-18T09:00:00.000Z') });
  opened = [];
  server = createServer({
    config,
    store,
    modules: [terminalModule({ open: (target) => Promise.resolve(void opened.push(target)) })],
  });
});
afterEach(async () => {
  await server.close();
  store.close();
});

const post = (id: number) =>
  server.app.request(`/api/sessions/${id}/terminal`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

describe('POST /api/sessions/:id/terminal', () => {
  it('opens the running session’s tmux window, and refuses one with no running agent', async () => {
    const shop = store.projects.create({ name: 'shop' });
    const live = store.sessions.create({
      projectId: shop.id,
      title: 'live',
      model: 'opus',
      branch: 'b1',
      tmuxTarget: 'loop:@5',
    });
    const paused = store.sessions.create({
      projectId: shop.id,
      title: 'paused',
      model: 'opus',
      branch: 'b2',
      status: 'paused',
      pauseReason: 'manual',
      tmuxTarget: null,
    });

    expect((await post(live.id)).status).toBe(200);
    expect(opened).toEqual(['loop:@5']);
    expect((await post(paused.id)).status).toBe(409);
    expect((await post(999)).status).toBe(404);
    expect(opened).toEqual(['loop:@5']);
  });
});
