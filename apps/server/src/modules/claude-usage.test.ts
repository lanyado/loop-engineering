import { FakeClock, openStore, type Store } from '@loop-engineering/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../config.js';
import { createServer, type LoopServer } from '../server.js';
import { claudeUsageModule, parseUsage } from './claude-usage.js';

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

// What scripts/capture-claude-usage.sh writes: the status line's rate_limits, untouched.
const SNAPSHOT = JSON.stringify({
  capturedAt: 1792314000, // 2026-10-18T09:00:00Z
  rateLimits: {
    five_hour: { used_percentage: 42.5, resets_at: 1792324800 },
    seven_day: { used_percentage: 71, resets_at: 1792713600 },
  },
});

let store: Store;
let server: LoopServer;
let files: Map<string, string>;

const start = () => {
  server = createServer({
    config,
    store,
    modules: [
      claudeUsageModule({
        file: '/state/claude-usage.json',
        read: (f) => {
          const text = files.get(f);
          return text === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(text);
        },
      }),
    ],
  });
};

async function getUsage(token: string | null = TOKEN) {
  const res = await server.app.request('/api/usage', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as { usage: unknown }) : null };
}

beforeEach(() => {
  store = openStore({ clock: new FakeClock('2026-10-18T09:00:00.000Z') });
  files = new Map();
  start();
});
afterEach(async () => {
  await server.close();
  store.close();
});

describe('GET /api/usage', () => {
  it('serves the saved 5-hour and weekly limits with ISO times', async () => {
    files.set('/state/claude-usage.json', SNAPSHOT);
    expect(await getUsage()).toEqual({
      status: 200,
      body: {
        usage: {
          capturedAt: '2026-10-18T09:00:00.000Z',
          fiveHour: { usedPercentage: 42.5, resetsAt: '2026-10-18T12:00:00.000Z' },
          sevenDay: { usedPercentage: 71, resetsAt: '2026-10-23T00:00:00.000Z' },
        },
      },
    });
  });

  it('is null before any snapshot, and needs the dashboard token', async () => {
    expect(await getUsage()).toEqual({ status: 200, body: { usage: null } });
    expect((await getUsage(null)).status).toBe(401);
  });
});

describe('parseUsage', () => {
  it('keeps a missing window as null and caps the percentage at 100', () => {
    const text = JSON.stringify({
      capturedAt: 1792314000,
      rateLimits: { seven_day: { used_percentage: 104, resets_at: 1792713600 } },
    });
    expect(parseUsage(text)).toMatchObject({ fiveHour: null, sevenDay: { usedPercentage: 100 } });
  });

  it('is null for a malformed file', () => {
    for (const text of [
      '',
      'not json',
      '{}',
      '{"capturedAt":1}',
      '{"capturedAt":1,"rateLimits":{"five_hour":{}}}',
    ]) {
      expect(parseUsage(text), text).toBeNull();
    }
  });
});
