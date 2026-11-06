import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, openStore } from '@loop-engineering/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runLoopCli } from './loop-cli.js';
import { RETRO_USAGE, runRetroCli, type RetroCliIo } from './retro-cli.js';

const env = { DASHBOARD_TOKEN: 'dash-token-0123456789', SERVER_URL: 'http://127.0.0.1:8787' };
const NOW = new Date('2026-11-06T08:00:00.000Z');

/** A database with one October session, its PR merged after a failed test round. */
function seed(path: string): void {
  const clock = new FakeClock('2026-10-05T09:00:00.000Z');
  const store = openStore({ path, clock });
  const web = [
    { name: 'web', path: '/src/web', remote: 'git@example.com:shop/web.git', defaultBranch: 'main' },
  ];
  const shop = store.projects.create({ name: 'shop', repos: web }).id;
  store.projects.create({ name: 'blog' });
  const s = store.sessions.create({ projectId: shop, title: 'cart', model: 'opus', branch: 'cart' }).id;
  const request = store.requests.create({
    projectId: shop,
    sessionId: s,
    text: 'Add a cart',
    source: 'dashboard',
  }).id;
  const pr = store.pullRequests.create({
    projectId: shop,
    repo: 'web',
    number: 4,
    url: 'https://github.example/pull/4',
    sessionId: s,
    requestId: request,
  }).id;
  store.pullRequests.update(pr, { round: 2, outcome: 'merged', loopState: { posted: ['tests-1-abcdef1'] } });
  clock.set('2026-10-05T12:00:00.000Z');
  store.history.add({
    projectId: shop,
    sessionId: s,
    kind: 'decision',
    text: 'PR web#4 merged (squash) as abcdef1.',
  });
  store.sessions.update(s, { status: 'ended' });
  store.requests.create({
    projectId: shop,
    text: 'Use plainsecretvalue42 and see [the docs](https://docs.example/x) *now*',
    source: 'email',
  });
  store.close();
}

/** A fake server: GET /projects, and POST /requests answered with request 7. */
function fakeServer(projects: { id: number; name: string }[]) {
  const posted: { url: string; body: unknown }[] = [];
  const fetch = ((url: string, init: RequestInit) => {
    if (new Headers(init.headers).get('Authorization') !== `Bearer ${env.DASHBOARD_TOKEN}`)
      return Promise.resolve(Response.json({ error: 'unauthorized' }, { status: 401 }));
    if (url.endsWith('/api/projects')) return Promise.resolve(Response.json({ projects }));
    if (url.endsWith('/api/requests') && init.method === 'POST') {
      posted.push({ url, body: JSON.parse(init.body as string) });
      return Promise.resolve(Response.json({ request: { id: 7 } }, { status: 201 }));
    }
    return Promise.resolve(Response.json({ error: 'not found' }, { status: 404 }));
  }) as typeof globalThis.fetch;
  return { fetch, posted };
}

describe('loop retro', () => {
  let dir: string;
  let db: string;
  let out: string[];
  let err: string[];
  let io: RetroCliIo;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-retro-cli-'));
    db = join(dir, 'data', 'loop.db');
    out = [];
    err = [];
    io = {
      env: { ...env },
      fetch: fakeServer([]).fetch,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      now: () => NOW,
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const withDb = () => {
    mkdirSync(join(dir, 'data'), { recursive: true });
    seed(db);
  };

  it('writes last month to retros/<YYYY-MM>.md beside the database and prints the path', async () => {
    withDb();
    expect(await runRetroCli(['--db', db], io)).toBe(0);
    const path = join(dir, 'data', 'retros', '2026-10.md');
    expect(out).toEqual([path]);
    const md = readFileSync(path, 'utf8');
    expect(md).toContain('# Loop retro: 2026-10-01 to 2026-10-31 (UTC)');
    expect(md).toContain('| PRs opened / merged | 1 / 1 |');
    expect(md).toContain('| tests | 1 | 0 | [#4](https://github.example/pull/4) |');
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('prints the report with --stdout, for one project, and finds the database through LOOP_DB_PATH', async () => {
    withDb();
    io.env.LOOP_DB_PATH = db;
    expect(
      await runRetroCli(
        ['--stdout', '--project', 'shop', '--since', '2026-10-01', '--until', '2026-10-31'],
        io,
      ),
    ).toBe(0);
    expect(out[0]).toMatch(/^# Loop retro: 2026-10-01 to 2026-10-31 \(UTC\)\n\nProject \*\*shop\*\*/);
    expect(existsSync(join(dir, 'data', 'retros'))).toBe(false);
  });

  it('names a project report after the project and honors --out-dir', async () => {
    withDb();
    expect(
      await runRetroCli(['--db', db, '--project', '1', '--days', '40', '--out-dir', join(dir, 'out')], io),
    ).toBe(0);
    expect(out).toEqual([join(dir, 'out', '2026-09-27_to_2026-11-06-shop.md')]);
  });

  it('refuses bad flags, a missing database and an unknown project', async () => {
    withDb();
    expect(await runRetroCli(['--days', '3', '--since', '2026-10-01', '--db', db], io)).toBe(2);
    expect(await runRetroCli(['--bogus'], io)).toBe(2);
    expect(await runRetroCli(['--db', join(dir, 'nope.db')], io)).toBe(1);
    expect(err.at(-1)).toMatch(/^No database at /);
    expect(await runRetroCli(['--db', db, '--project', 'nope'], io)).toBe(1);
    expect(err.at(-1)).toBe('No project "nope". Projects: shop, blog');
  });

  it('is reached through `loop retro`', async () => {
    const ioWithGit = { ...io, git: () => null };
    expect(await runLoopCli(['retro', '--help'], ioWithGit)).toBe(0);
    expect(out).toEqual([RETRO_USAGE]);
  });

  it('files the report as a request only with --file-request', async () => {
    withDb();
    const server = fakeServer([
      { id: 1, name: 'shop' },
      { id: 2, name: 'blog' },
    ]);
    io.fetch = server.fetch;
    expect(await runRetroCli(['--db', db, '--stdout'], io)).toBe(0);
    expect(server.posted).toEqual([]);

    // A report of every project would carry them all to one builder: it needs --project.
    expect(await runRetroCli(['--db', db, '--stdout', '--file-request'], io)).toBe(2);
    expect(err.at(-1)).toMatch(/^--file-request needs --project/);

    out = [];
    expect(await runRetroCli(['--db', db, '--stdout', '--file-request', '--project', 'shop'], io)).toBe(0);
    expect(server.posted).toHaveLength(1);
    const body = server.posted[0]!.body as {
      projectId: number;
      text: string;
      attachments: { name: string; data: string }[];
    };
    expect(body.projectId).toBe(1);
    expect(body.text.length).toBeLessThanOrEqual(4000);
    expect(body.text).toContain('propose improvements to the pipeline');
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]!.name).toBe('2026-10-shop.md');
    expect(Buffer.from(body.attachments[0]!.data, 'base64').toString('utf8')).toBe(`${out[0]}\n`);
    expect(out).toHaveLength(1);
    expect(err.at(-1)).toBe('Filed request 7 in shop: a builder will propose improvements from the retro.');

    // --request-project sends it elsewhere.
    expect(
      await runRetroCli(
        ['--db', db, '--stdout', '--file-request', '--project', 'shop', '--request-project', 'blog'],
        io,
      ),
    ).toBe(0);
    expect((server.posted[1]!.body as { projectId: number }).projectId).toBe(2);
  });

  it('reads --db from the current folder, writes the report 0600 over a stale temp file, masks secrets', async () => {
    withDb();
    io.env.INIT_CWD = join(dir, 'data');
    io.env.SHOP_API_TOKEN = 'plainsecretvalue42';
    const retros = join(dir, 'data', 'retros');
    mkdirSync(retros);
    writeFileSync(join(retros, '2026-10.md.tmp'), 'stale', { mode: 0o644 });
    expect(await runRetroCli(['--db', 'loop.db'], io)).toBe(0);
    const path = join(retros, '2026-10.md');
    expect(out).toEqual([path]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const md = readFileSync(path, 'utf8');
    expect(md).not.toContain('plainsecretvalue42');
    // Link and emphasis syntax from the database is escaped, not rendered.
    expect(md).toContain('see \\[the docs\\](https://docs.example/x) \\*now\\*');
  });

  it('files nothing for a quiet window', async () => {
    withDb();
    const server = fakeServer([{ id: 1, name: 'shop' }]);
    io.fetch = server.fetch;
    expect(
      await runRetroCli(
        [
          '--db',
          db,
          '--stdout',
          '--file-request',
          '--project',
          'shop',
          '--since',
          '2026-01-01',
          '--until',
          '2026-01-31',
        ],
        io,
      ),
    ).toBe(0);
    expect(server.posted).toEqual([]);
    expect(err.at(-1)).toBe('Nothing happened in this window, so no request was filed.');
  });
});
