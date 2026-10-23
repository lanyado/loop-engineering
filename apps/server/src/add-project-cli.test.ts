import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProject, projectName, runAddProjectCli, serverUrl, type Git } from './add-project-cli.js';

/** A fake git: answers by the command's first words, null for anything else. */
const fakeGit =
  (answers: Record<string, string>): Git =>
  (args) =>
    answers[args.join(' ')] ?? null;

const REPO_GIT = fakeGit({
  'rev-parse --show-toplevel': '/Users/me/shop-web',
  'remote get-url origin': 'git@github.com:me/shop-web.git',
  'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/trunk',
});

describe('detectProject', () => {
  it('makes a git project from the repository root, its origin and default branch', () => {
    expect(detectProject('/Users/me/shop-web/src', REPO_GIT, {})).toEqual({
      name: 'shop-web',
      kind: 'git',
      repos: [
        {
          name: 'shop-web',
          path: '/Users/me/shop-web',
          remote: 'git@github.com:me/shop-web.git',
          defaultBranch: 'trunk',
        },
      ],
    });
  });

  it('falls back to the current branch without origin/HEAD', () => {
    const git = fakeGit({
      'rev-parse --show-toplevel': '/r',
      'remote get-url origin': 'https://github.com/me/r.git',
      'rev-parse --abbrev-ref HEAD': 'develop',
    });
    const project = detectProject('/r', git, {});
    expect(project.kind === 'git' && project.repos[0]?.defaultBranch).toBe('develop');
  });

  it('refuses a git repository without origin, pointing at --folder', () => {
    const git = fakeGit({ 'rev-parse --show-toplevel': '/r' });
    expect(() => detectProject('/r', git, {})).toThrow(/no remote named origin.*--folder/);
  });

  it('makes a folder project outside git, and with --folder inside it', () => {
    expect(detectProject('/Users/me/my notes', fakeGit({}), {})).toEqual({
      name: 'my-notes',
      kind: 'folder',
      folderPath: '/Users/me/my notes',
    });
    expect(detectProject('/Users/me/shop-web', REPO_GIT, { folder: true, name: 'shop' })).toEqual({
      name: 'shop',
      kind: 'folder',
      folderPath: '/Users/me/shop-web',
      allowGitFolder: true,
    });
  });

  it('turns folder names into valid project names', () => {
    expect(projectName('My App (v2)')).toBe('My-App-v2');
    expect(projectName('***')).toBe('project');
  });
});

describe('serverUrl', () => {
  it('uses SERVER_URL, else the local port', () => {
    expect(serverUrl({ SERVER_URL: 'http://127.0.0.1:9000/' })).toBe('http://127.0.0.1:9000');
    expect(serverUrl({ SERVER_PORT: '8800' })).toBe('http://127.0.0.1:8800');
    expect(serverUrl({})).toBe('http://127.0.0.1:8787');
  });
});

describe('npm run add-project', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let requests: { url: string; init: RequestInit }[];
  const env = { DASHBOARD_TOKEN: 'dash-token-0123456789', SERVER_URL: 'http://127.0.0.1:8787' };

  const cli = (
    argv: string[],
    respond: () => Promise<Response>,
    over: { env?: Record<string, string> } = {},
  ) =>
    runAddProjectCli(argv, {
      env: over.env ?? env,
      git: fakeGit({}),
      fetch: ((url: string, init: RequestInit) => {
        requests.push({ url, init });
        return respond();
      }) as typeof fetch,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
  const created = () => Promise.resolve(Response.json({ project: { id: 1 } }, { status: 201 }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-add-project-'));
    out = [];
    err = [];
    requests = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('posts the project with the dashboard token and says what to do next', async () => {
    expect(await cli([dir, '--name', 'notes'], created)).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('http://127.0.0.1:8787/api/projects');
    expect(new Headers(requests[0]!.init.headers).get('Authorization')).toBe(`Bearer ${env.DASHBOARD_TOKEN}`);
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({
      name: 'notes',
      kind: 'folder',
      folderPath: dir,
    });
    expect(out[0]).toBe(`✓ Added folder project "notes" (${dir}).`);
    expect(out[1]).toContain(`cd ${dir} && claude`);
  });

  it("prints the server's refusal", async () => {
    const refused = () =>
      Promise.resolve(Response.json({ error: 'a project named "notes" exists' }, { status: 409 }));
    expect(await cli([dir, '--name', 'notes'], refused)).toBe(1);
    expect(err).toEqual(['The server refused the project: a project named "notes" exists']);
  });

  it('passes --outside-home on and names the flag in a refusal', async () => {
    const refused = () =>
      Promise.resolve(
        Response.json(
          {
            error: `folder ${dir} is outside your home folder; pass allowOutsideHome: true if you really mean it`,
          },
          { status: 400 },
        ),
      );
    expect(await cli([dir], refused)).toBe(1);
    expect(err[0]).toContain('pass --outside-home if you really mean it');
    expect(await cli([dir, '--outside-home'], created)).toBe(0);
    expect(JSON.parse(requests[1]!.init.body as string)).toMatchObject({ allowOutsideHome: true });
  });

  it('says to start the server when it cannot be reached', async () => {
    expect(await cli([dir], () => Promise.reject(new TypeError('fetch failed')))).toBe(1);
    expect(err[0]).toMatch(
      /Cannot reach the server at http:\/\/127\.0\.0\.1:8787\. Start it with `npm start`/,
    );
  });

  it('checks the folder and the token before calling the server', async () => {
    const file = join(dir, 'file.txt');
    writeFileSync(file, '');
    expect(await cli([file], created)).toBe(1);
    expect(err[0]).toBe(`${file} is not a folder.`);
    expect(await cli([dir], created, { env: {} })).toBe(1);
    expect(err[1]).toMatch(/DASHBOARD_TOKEN is not set.*npm run setup/);
    expect(requests).toHaveLength(0);
  });

  it('prints usage for a missing path or an unknown option', async () => {
    expect(await cli([], created)).toBe(2);
    expect(await cli([dir, '--nope'], created)).toBe(2);
    expect(await cli(['--help'], created)).toBe(0);
    expect(out[0]).toMatch(/^Usage: npm run add-project/);
  });
});
