import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, openStore } from '@loop-engineering/core';
import { FileStageLibrary, loopState } from '@loop-engineering/loop';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../config.js';
import { createServer } from '../server.js';
import { pipelineModule } from './pipeline.js';

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

describe('POST /api/prs/:id/skip', () => {
  it('skips a check for one PR and pokes the loop, with the loop off too; refuses bad requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skip-'));
    const store = openStore({ clock: new FakeClock('2026-10-24T09:00:00.000Z') });
    const shop = store.projects.create({
      name: 'shop',
      repos: [
        { name: 'web', path: '/Users/me/web', remote: 'git@github.com:me/web.git', defaultBranch: 'main' },
      ],
    });
    const pr = store.pullRequests.create({ projectId: shop.id, repo: 'web', number: 7, url: 'https://x/7' });
    let pokes = 0;
    const server = createServer({
      config,
      store,
      modules: [
        pipelineModule({
          stages: new FileStageLibrary(join(dir, 'stages'), () => undefined),
          poke: () => void pokes++,
        }),
      ],
    });
    await server.start();
    const post = (id: number, body: unknown) =>
      server.app.request(`/api/prs/${id}/skip`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      expect((await post(pr.id, { check: 'tests', skip: true })).status).toBe(200);
      expect(loopState(store.pullRequests.require(pr.id)).skip).toEqual(['tests']);
      expect(pokes).toBe(1);
      expect((await post(pr.id, { check: 'tests' })).status).toBe(400);
      expect((await post(pr.id, { check: 'merge', skip: true })).status).toBe(400);
      expect((await post(999, { check: 'tests', skip: true })).status).toBe(404);
      expect((await post(pr.id, { check: 'tests', skip: false })).status).toBe(200);
      expect(loopState(store.pullRequests.require(pr.id)).skip).toBeUndefined();
    } finally {
      await server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
