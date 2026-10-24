import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, openStore } from '@loop-engineering/core';
import { FileStageLibrary } from '@loop-engineering/loop';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

const security = {
  title: 'Security review',
  label: 'Security',
  icon: 'shield',
  access: 'read',
  runs: 'always',
  prompt: 'Look for leaked secrets.',
};

describe('GET and PUT /api/pipeline', () => {
  let dir: string;
  let server: ReturnType<typeof createServer>;
  let store: ReturnType<typeof openStore>;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pipeline-'));
    store = openStore({ clock: new FakeClock('2026-10-24T09:00:00.000Z') });
    server = createServer({
      config,
      store,
      modules: [pipelineModule({ stages: new FileStageLibrary(join(dir, 'stages'), () => undefined) })],
    });
    await server.start();
  });
  afterEach(async () => {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (method: string, body?: unknown, token = TOKEN) =>
    server.app.request('/api/pipeline', {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('serves the built-in pipeline and stages', async () => {
    const res = await call('GET');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pipeline: unknown; stages: { id: string; builtin: boolean }[] };
    expect(json.pipeline).toEqual({ checks: ['tests', 'review', 'qa'], deploy: true, guardian: true });
    expect(json.stages.map((s) => [s.id, s.builtin])).toEqual([
      ['tests', true],
      ['review', true],
      ['qa', true],
    ]);
  });

  it('writes a new stage and the order, then serves them', async () => {
    const res = await call('PUT', {
      pipeline: { checks: ['security', 'tests', 'review'], deploy: false, guardian: true },
      stages: { security },
    });
    expect(res.status).toBe(200);
    expect(readFileSync(join(dir, 'stages', 'security.md'), 'utf8')).toContain('Look for leaked secrets.');
    const json = (await (await call('GET')).json()) as { pipeline: { checks: string[]; deploy: boolean } };
    expect(json.pipeline).toMatchObject({ checks: ['security', 'tests', 'review'], deploy: false });
  });

  it.each([
    ['an unknown stage in the order', { pipeline: { checks: ['ghost'], deploy: true, guardian: true } }],
    [
      'a path as an id',
      { pipeline: { checks: [], deploy: true, guardian: true }, stages: { '../x': security } },
    ],
    [
      'write access',
      {
        pipeline: { checks: [], deploy: true, guardian: true },
        stages: { s: { ...security, access: 'write' } },
      },
    ],
    ['an unknown key', { pipeline: { checks: [], deploy: true, guardian: true }, extra: 1 }],
    ['no pipeline', { stages: {} }],
  ])('rejects %s with 400 and writes nothing', async (_, body) => {
    expect((await call('PUT', body)).status).toBe(400);
    expect(existsSync(join(dir, 'stages'))).toBe(false);
  });

  it('needs the dashboard token', async () => {
    expect((await call('GET', undefined, 'wrong')).status).toBe(401);
  });
});
