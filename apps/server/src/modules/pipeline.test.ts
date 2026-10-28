import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, openStore } from '@loop-engineering/core';
import { FileStageLibrary, loopState } from '@loop-engineering/loop';
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

describe('the pipeline API', () => {
  let dir: string;
  let pokes: number[];
  let server: ReturnType<typeof createServer>;
  let store: ReturnType<typeof openStore>;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pipeline-'));
    store = openStore({ clock: new FakeClock('2026-10-24T09:00:00.000Z') });
    pokes = [];
    const stages = new FileStageLibrary(join(dir, 'stages'), () => undefined);
    server = createServer({
      config,
      store,
      modules: [pipelineModule({ stages, pokePr: (id) => void pokes.push(id) })],
    });
    await server.start();
  });
  afterEach(async () => {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (method: string, body?: unknown, token = TOKEN, path = '/api/pipeline') =>
    server.app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('serves the built-in pipeline and stages', async () => {
    const res = await call('GET');
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      pipeline: unknown;
      stages: { id: string; builtin: boolean }[];
      choices: { reserved: string[]; icons: string[] };
    };
    expect(json.pipeline).toEqual({ checks: ['tests', 'review', 'qa'], deploy: true, guardian: true });
    expect(json).not.toHaveProperty('rigor'); // every level runs every stage: nothing to list
    expect(json.choices).toMatchObject({
      icons: expect.arrayContaining(['shield']) as unknown,
      reserved: expect.arrayContaining(['merge', 'deploy']) as unknown,
    });
    expect(json.stages.map((s) => [s.id, s.builtin])).toEqual([
      ['tests', true],
      ['review', true],
      ['qa', true],
    ]);
  });

  it("serves the Planner's instructions and writes planner.md, never as a check", async () => {
    type View = { planner: { id: string; prompt: string; overridden: boolean }; stages: { id: string }[] };
    const before = (await (await call('GET')).json()) as View;
    expect(before.planner).toMatchObject({ id: 'planner', overridden: false });
    expect(before.planner.prompt).toContain('ask_human');
    const planner = {
      ...security,
      title: 'Planner',
      label: 'Planner',
      icon: 'check',
      prompt: 'Plan in five lines.',
    };
    const pipeline = { checks: ['tests', 'review', 'qa'], deploy: true, guardian: true };
    expect((await call('PUT', { pipeline, stages: { planner } })).status).toBe(200);
    expect(readFileSync(join(dir, 'stages', 'planner.md'), 'utf8')).toContain('Plan in five lines.');
    const after = (await (await call('GET')).json()) as View;
    expect(after.planner).toMatchObject({ prompt: 'Plan in five lines.', overridden: true });
    expect(after.stages.map((s) => s.id)).not.toContain('planner');
    expect((await call('PUT', { pipeline, stages: { planner: null } })).status).toBe(200);
    expect(existsSync(join(dir, 'stages', 'planner.md'))).toBe(false);
    expect(
      (await call('PUT', { pipeline: { ...pipeline, checks: ['planner'] } })).status,
      'the planner is never a check',
    ).toBe(400);
  });

  it('writes a new stage and the order, then serves them', async () => {
    const res = await call('PUT', {
      pipeline: { checks: ['security', 'tests', 'review'], deploy: false, guardian: true },
      stages: { security },
    });
    expect(res.status).toBe(200);
    expect(readFileSync(join(dir, 'stages', 'security.md'), 'utf8')).toContain('Look for leaked secrets.');
    const json = (await (await call('GET')).json()) as {
      pipeline: { checks: string[]; deploy: boolean };
    };
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

  it('takes a full change of long non-ASCII prompts (bytes, not characters, count against the body limit)', async () => {
    const stages = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`check-${i}`, { ...security, prompt: 'בדוק'.repeat(1000) }]),
    );
    const res = await call('PUT', {
      pipeline: { checks: Object.keys(stages), deploy: true, guardian: true },
      stages,
    });
    expect(res.status).toBe(200);
  });

  it('says why when the stages folder cannot be written', async () => {
    mkdirSync(join(dir, 'stages'));
    chmodSync(join(dir, 'stages'), 0o500);
    try {
      const res = await call('PUT', { pipeline: { checks: ['tests'], deploy: true, guardian: true } });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /^could not write the stage files: EACCES/,
      );
    } finally {
      chmodSync(join(dir, 'stages'), 0o700);
    }
  });

  it('POST /prs/:id/skip skips a check for one PR and pokes the loop for that PR; refuses bad requests', async () => {
    const shop = store.projects.create({
      name: 'shop',
      repos: [
        { name: 'web', path: '/Users/me/web', remote: 'git@github.com:me/web.git', defaultBranch: 'main' },
      ],
    });
    const pr = store.pullRequests.create({ projectId: shop.id, repo: 'web', number: 7, url: 'https://x/7' });
    const skip = (id: number, body: unknown) => call('POST', body, TOKEN, `/api/prs/${id}/skip`);
    expect((await skip(pr.id, { check: 'tests', skip: true })).status).toBe(200);
    expect(loopState(store.pullRequests.require(pr.id)).skip).toEqual(['tests']);
    expect(pokes).toEqual([pr.id]);
    expect((await skip(pr.id, { check: 'tests' })).status).toBe(400);
    expect((await skip(pr.id, { check: 'merge', skip: true })).status).toBe(400);
    expect((await skip(999, { check: 'tests', skip: true })).status).toBe(404);
    for (const bad of ['abc', '0', '-1', '1.5'])
      expect((await call('POST', { check: 'tests', skip: true }, TOKEN, `/api/prs/${bad}/skip`)).status).toBe(
        400,
      );
    expect((await skip(pr.id, { check: 'tests', skip: false })).status).toBe(200);
    expect(loopState(store.pullRequests.require(pr.id)).skip).toBeUndefined();
  });

  it('needs the dashboard token', async () => {
    expect((await call('GET', undefined, 'wrong')).status).toBe(401);
  });
});
