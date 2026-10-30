import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Git } from './add-project-cli.js';
import { LOOP_USAGE, runLoopCli } from './loop-cli.js';

const env = { DASHBOARD_TOKEN: 'dash-token-0123456789', SERVER_URL: 'http://127.0.0.1:8787' };

/** A fake server: GET /projects lists `projects`, POST /projects adds one, POST /pipeline inits once. */
function fakeServer(projects: Record<string, unknown>[]) {
  const requests: { method: string; url: string; body: unknown }[] = [];
  const own = new Set<number>();
  const fetch = ((url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const body: unknown = init.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ method, url: url.replace(env.SERVER_URL, ''), body });
    if (new Headers(init.headers).get('Authorization') !== `Bearer ${env.DASHBOARD_TOKEN}`)
      return Promise.resolve(Response.json({ error: 'unauthorized' }, { status: 401 }));
    if (url.endsWith('/api/projects') && method === 'GET')
      return Promise.resolve(Response.json({ projects }));
    if (url.endsWith('/api/projects') && method === 'POST') {
      const project = { ...(body as object), id: projects.length + 1 };
      projects.push(project);
      return Promise.resolve(Response.json({ project }, { status: 201 }));
    }
    const init_ = /\/api\/pipeline\?project=(\d+)$/.exec(url);
    if (init_ && method === 'POST') {
      const id = Number(init_[1]);
      const project = projects.find((p) => p.id === id);
      if (!project) return Promise.resolve(Response.json({ error: 'no such project' }, { status: 404 }));
      const created = !own.has(id);
      own.add(id);
      const home = (project.folderPath as string | null) ?? (project.repos as { path: string }[])[0]!.path;
      return Promise.resolve(
        Response.json(
          { created, project: { id, own: true, dir: `${home}/.loop-engineering` } },
          { status: created ? 201 : 200 },
        ),
      );
    }
    return Promise.resolve(Response.json({ error: 'not found' }, { status: 404 }));
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

/** A fake git: answers by the command's words, null for anything else. */
const fakeGit =
  (answers: Record<string, string>): Git =>
  (args) =>
    answers[args.join(' ')] ?? null;

describe('loop init', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'loop-init-')));
    out = [];
    err = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (
    argv: string[],
    server: ReturnType<typeof fakeServer>,
    over: { env?: Record<string, string>; git?: Git } = {},
  ) =>
    runLoopCli(argv, {
      env: over.env ?? env,
      git: over.git ?? fakeGit({}),
      fetch: server.fetch,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });

  it('adds a folder the server does not know, then gives it its own pipeline', async () => {
    const server = fakeServer([]);
    expect(await cli(['init', dir, '--name', 'notes'], server)).toBe(0);
    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /api/projects',
      'POST /api/projects',
      'POST /api/pipeline?project=1',
    ]);
    expect(server.requests[1]!.body).toEqual({ name: 'notes', kind: 'folder', folderPath: dir });
    expect(out[0]).toBe(`✓ Added folder project "notes" (${dir}).`);
    expect(out).toContain(
      `✓ notes has its own pipeline now, in ${dir}/.loop-engineering (a copy of the shared one).`,
    );
    expect(out.at(-1)).toContain('in the "notes" tab');
    expect(err).toEqual([]);
  });

  it("finds a git project by any of its repos' checkouts, run from a subfolder", async () => {
    const server = fakeServer([
      { id: 1, name: 'other', kind: 'folder', folderPath: '/Users/me/other', repos: [] },
      {
        id: 2,
        name: 'shop',
        kind: 'git',
        folderPath: null,
        repos: [{ path: '/Users/me/shop-web' }, { path: dir }],
      },
    ]);
    const git = fakeGit({
      'rev-parse --show-toplevel': dir,
      'remote get-url origin': 'git@github.com:me/shop-api.git',
    });
    // Typed in a subfolder: INIT_CWD is where, the path is relative to it.
    expect(await cli(['init'], server, { env: { ...env, INIT_CWD: dir }, git })).toBe(0);
    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /api/projects',
      'POST /api/pipeline?project=2',
    ]);
    // A project keeps its pipeline in its first repo.
    expect(out[0]).toBe(
      '✓ shop has its own pipeline now, in /Users/me/shop-web/.loop-engineering (a copy of the shared one).',
    );
  });

  it('changes nothing the second time', async () => {
    const server = fakeServer([]);
    expect(await cli(['init', dir, '--name', 'notes'], server)).toBe(0);
    out = [];
    expect(await cli(['init', dir, '--name', 'notes'], server)).toBe(0);
    expect(server.requests.filter((r) => r.url === '/api/projects' && r.method === 'POST')).toHaveLength(1);
    expect(out).toEqual([
      `notes already has its own pipeline in ${dir}/.loop-engineering; it was left as it is.`,
    ]);
  });

  it("prints the server's refusals", async () => {
    const refusing = fakeServer([]);
    const fetch = refusing.fetch;
    refusing.fetch = ((url: string, init: RequestInit) =>
      url.endsWith('/api/pipeline?project=1')
        ? Promise.resolve(Response.json({ error: 'the folder is not there' }, { status: 400 }))
        : fetch(url, init)) as typeof globalThis.fetch;
    expect(await cli(['init', dir, '--name', 'notes'], refusing)).toBe(1);
    expect(err).toEqual(['The server could not give notes its own pipeline: the folder is not there']);
  });

  it('says to start the server when it cannot be reached', async () => {
    const down = {
      fetch: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch,
      requests: [],
    };
    expect(await cli(['init', dir], down)).toBe(1);
    expect(err[0]).toMatch(
      /Cannot reach the server at http:\/\/127\.0\.0\.1:8787\. Start it with `npm start`/,
    );
  });

  it('needs the dashboard token, a folder and the init command', async () => {
    const server = fakeServer([]);
    expect(await cli(['init', dir], server, { env: { SERVER_URL: env.SERVER_URL } })).toBe(1);
    expect(err.at(-1)).toContain('DASHBOARD_TOKEN is not set');
    expect(await cli(['init', join(dir, 'missing')], server)).toBe(1);
    expect(err.at(-1)).toBe(`${join(dir, 'missing')} is not a folder.`);
    expect(await cli([], server)).toBe(2);
    expect(await cli(['deploy'], server)).toBe(2);
    expect(err.at(-1)).toBe(LOOP_USAGE);
    expect(await cli(['--help'], server)).toBe(0);
    expect(out.at(-1)).toBe(LOOP_USAGE);
    expect(server.requests).toEqual([]);
  });

  it('a git repository without origin needs --folder', async () => {
    const server = fakeServer([]);
    const git = fakeGit({ 'rev-parse --show-toplevel': dir });
    expect(await cli(['init', dir], server, { git })).toBe(1);
    expect(err[0]).toContain('pass --folder');
    expect(await cli(['init', dir, '--folder'], server, { git })).toBe(0);
    expect(server.requests[1]!.body).toMatchObject({ kind: 'folder', allowGitFolder: true });
  });
});
