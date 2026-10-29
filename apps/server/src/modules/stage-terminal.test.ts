import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, openStore } from '@loop-engineering/core';
import { jobLogFile, type LoopEngine } from '@loop-engineering/loop';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../config.js';
import { createServer } from '../server.js';
import { loopModule } from './loop.js';
import { WebTerminals, type WebTerminalSpec } from './web-terminals.js';

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

describe('POST /api/prs/:id/terminal', () => {
  it("opens a terminal following the stage's job log once that stage has run", async () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'logs-'));
    const store = openStore({ clock: new FakeClock('2026-10-19T09:00:00.000Z') });
    const shop = store.projects.create({
      name: 'shop',
      repos: [
        { name: 'web', path: '/Users/me/web', remote: 'git@github.com:me/web.git', defaultBranch: 'main' },
      ],
    });
    const pr = store.pullRequests.create({ projectId: shop.id, repo: 'web', number: 7, url: 'https://x/7' });
    const opened: [string, string][] = [];
    const specs: WebTerminalSpec[] = [];
    const web = new WebTerminals(
      (spec) => (specs.push(spec), Promise.resolve({ stop() {}, exited: new Promise<void>(() => {}) })),
      () => Promise.resolve(7722),
    );
    const engine = { config: { logsDir, maxConcurrentJobs: 1 }, start() {}, stop: async () => {}, poke() {} };
    const server = createServer({
      config,
      store,
      modules: [
        loopModule({
          createEngine: () => engine as unknown as LoopEngine,
          web,
          openCommand: (name, line) => Promise.resolve(void opened.push([name, line])),
          log: () => undefined,
        }),
      ],
    });
    await server.start();
    const post = (body: unknown) =>
      server.app.request(`/api/prs/${pr.id}/terminal`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      expect((await post({ stage: 'review' })).status).toBe(409); // not run yet
      expect((await post({ stage: 'merge' })).status).toBe(400);
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(jobLogFile(logsDir, pr.id, 'review'), '=== review ===\n');
      expect((await post({ stage: 'review' })).status).toBe(200);
      expect(opened[0]?.[0]).toBe(`pr${pr.id}-review`);
      expect(opened[0]?.[1]).toContain('follow-job.mjs');
      expect(opened[0]?.[1]).toContain(`pr${pr.id}-review.log'`);
      const web1 = (stage: string) =>
        server.app.request(`/api/prs/${pr.id}/web-terminal`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage }),
        });
      const ok = await web1('review');
      expect(await ok.json()).toEqual({ url: 'http://localhost:7722' });
      expect(specs[0]).toMatchObject({ writable: false, key: `pr${pr.id}-review` });
      expect((await web1('tests')).status).toBe(409);
      expect((await web1('merge')).status).toBe(400);
    } finally {
      await server.close();
      store.close();
      rmSync(logsDir, { recursive: true, force: true });
    }
  });
});
