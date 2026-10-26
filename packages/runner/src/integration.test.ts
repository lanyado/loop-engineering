// Real tmux + git + filesystem, with fake agent scripts standing in for `claude` and `opencode`.
// Uses its own tmux server (-L loop-test) and a temp dir under the OS temp folder; both are removed after.
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { FakeClock, openStore, type Store } from '@loop-engineering/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DefaultAgentCli } from './agent-cli.js';
import { unattendedNote } from './instructions.js';
import { nodeFs } from './drivers/fs.js';
import { RealGitDriver } from './drivers/git.js';
import { RealTmuxDriver } from './drivers/tmux.js';
import { UsageLimitMonitor } from './monitor.js';
import { SessionRunner } from './runner.js';

const SOCKET = 'loop-test';
const run = promisify(execFile);

function hasTmux(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 10_000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe.skipIf(!hasTmux())('runner with real tmux (fake agents)', () => {
  let dir: string;
  let store: Store;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loop-runner-it-'));
    store = openStore({ clock: new FakeClock() });
  });

  afterAll(async () => {
    store.close();
    await run('tmux', ['-L', SOCKET, 'kill-server']).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it(
    'starts a session, detects the usage limit, relaunches on OpenCode, reconciles a dead agent',
    { timeout: 30_000 },
    async () => {
      const repo = join(dir, 'repo');
      const git = (cwd: string, ...args: string[]) =>
        run('git', ['-C', cwd, '-c', 'user.name=Loop Test', '-c', 'user.email=loop@test.invalid', ...args]);
      await run('git', ['init', '-q', '-b', 'main', repo]);
      await writeFile(join(repo, 'README.md'), '# demo\n');
      // The repo tracks its own .mcp.json and .env.local: the runner must not modify either.
      const repoMcp = `${JSON.stringify({ mcpServers: { own: { command: 'own-server' } } })}\n`;
      await writeFile(join(repo, '.mcp.json'), repoMcp);
      await writeFile(join(repo, '.env.local'), 'TRACKED=1\n');
      const permissive = `${JSON.stringify({ permission: 'allow', model: 'paid/model' })}\n`;
      await writeFile(join(repo, 'opencode.json'), permissive);
      await git(repo, 'add', '.');
      await git(repo, 'commit', '-q', '-m', 'Initial commit');

      const secrets = join(dir, 'web.env');
      await writeFile(secrets, 'API_KEY=secret\n');
      const trackedSource = join(dir, 'tracked.env');
      await writeFile(trackedSource, 'SHOULD_NOT_APPEAR=1\n');
      const fakeClaude = join(dir, 'fake-claude.sh');
      await writeFile(
        fakeClaude,
        [
          '#!/bin/sh',
          'echo "FAKE CLAUDE timeout=$MCP_TOOL_TIMEOUT model=$4 opencode_config=$OPENCODE_CONFIG"',
          'echo "Claude AI usage limit reached|1760792400"',
          'exec sleep 300',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      const argsOut = join(dir, 'opencode-args.txt');
      const fakeOpencode = join(dir, 'fake-opencode.sh');
      await writeFile(
        fakeOpencode,
        [
          '#!/bin/sh',
          `printf '%s\\n' "$@" > '${argsOut}'`,
          `printf '%s' "$OPENCODE_CONFIG_CONTENT" > '${argsOut}.inline'`,
          'echo "FAKE OPENCODE running"',
          'exec sleep 300',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );

      const tmux = new RealTmuxDriver({ socketName: SOCKET });
      const logs: string[] = [];
      const runner = new SessionRunner(
        {
          store,
          tmux,
          git: new RealGitDriver(),
          fs: nodeFs,
          agentCli: new DefaultAgentCli({ claude: fakeClaude, opencode: fakeOpencode }),
          log: (m) => logs.push(m),
        },
        {
          worktreesRoot: join(dir, 'worktrees'),
          serverUrl: 'http://127.0.0.1:1',
          tmuxSession: 'loop-it',
          env: { MCP_TOKEN: 'test-token' },
          claudeProjectsDir: join(dir, 'claude-projects'),
        },
      );
      const project = store.projects.create({
        name: 'demo',
        repos: [{ name: 'web', path: repo, remote: 'none', defaultBranch: 'main' }],
        envFiles: [
          { repo: 'web', source: secrets, target: 'config/.env' },
          { repo: 'web', source: trackedSource, target: '.env.local' },
        ],
      });

      const s = await runner.startSession(project.id, { text: 'Build the demo feature' });
      const wt = s.worktrees[0]?.path ?? '';
      expect(await readFile(join(wt, 'config/.env'), 'utf8')).toBe('API_KEY=secret\n');
      expect(await readFile(join(wt, '.env.local'), 'utf8')).toBe('TRACKED=1\n');
      expect(await readFile(join(wt, '.mcp.json'), 'utf8')).toBe(repoMcp);
      expect(logs).toEqual([
        expect.stringContaining('could not fetch origin/main'),
        expect.stringContaining('the repo tracks that path'),
      ]);
      expect(await exists(join(wt, '.claude/skills/opensource-search/SKILL.md'))).toBe(true);
      expect((await git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()).toBe(s.branch);
      // Tracked files untouched and runner-written files excluded: the fresh worktree is clean.
      expect((await git(wt, 'status', '--short')).stdout).toBe('');
      const configDir = join(dir, 'worktrees/.loop-runner/s1');
      const mcp = JSON.parse(await readFile(join(configDir, 'mcp.json'), 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(mcp.mcpServers)).toEqual(expect.arrayContaining(['own', 'ask_human', 'github']));

      const pane = await waitFor('the fake claude output', async () => {
        const text = await tmux.capture(s.tmuxTarget ?? '');
        return text.includes('usage limit reached') && text;
      });
      expect(pane).toContain(
        `FAKE CLAUDE timeout=1200000 model=opus opencode_config=${configDir}/opencode.json`,
      );

      await writeFile(join(wt, 'feature.txt'), 'wip\n');
      const monitor = new UsageLimitMonitor(runner, store);
      const pass = await monitor.checkOnce();
      expect(pass.switched.map((x) => x.id)).toEqual([s.id]);
      const after = store.sessions.require(s.id);
      expect(after).toMatchObject({
        status: 'active',
        provider: 'opencode',
        model: 'opencode/glm-5.3-flash-free',
      });

      const args = await waitFor('the fake opencode args', () => readFile(argsOut, 'utf8'));
      expect(args.split('\n').slice(0, 3)).toEqual([
        '--standalone',
        '--auto',
        `--prompt=${unattendedNote(1)}`,
      ]);
      // The repo's permissive opencode.json is untouched, and the inline config (highest precedence) caps it.
      expect(await readFile(join(wt, 'opencode.json'), 'utf8')).toBe(permissive);
      const inline = JSON.parse(await readFile(`${argsOut}.inline`, 'utf8')) as Record<string, unknown>;
      expect(inline).toMatchObject({
        model: 'opencode/glm-5.3-flash-free',
        permission: { '*': 'allow', github_merge_pull_request: 'deny' },
      });
      for (const piece of [
        'You are taking over',
        'Build the demo feature',
        s.branch,
        '?? feature.txt',
        'Initial commit',
      ]) {
        expect(args).toContain(piece);
      }
      await waitFor('the fake opencode output', async () =>
        (await tmux.capture(after.tmuxTarget ?? '')).includes('FAKE OPENCODE running'),
      );
      expect((await tmux.list('loop-it')).map((w) => w.target)).toEqual([after.tmuxTarget]);

      // The agent dies: its window closes, and the next pass pauses the session.
      await run('tmux', ['-L', SOCKET, 'kill-window', '-t', after.tmuxTarget ?? '']);
      expect((await monitor.checkOnce()).exited.map((x) => x.id)).toEqual([s.id]);
      expect(store.sessions.require(s.id)).toMatchObject({ status: 'paused', pauseReason: 'agent_exited' });
      const resumed = await runner.resume(s.id, { ifReason: 'agent_exited' });
      await waitFor('the resumed fake opencode', async () =>
        (await tmux.capture(resumed.tmuxTarget ?? '')).includes('FAKE OPENCODE running'),
      );
      expect(await readFile(argsOut, 'utf8')).toContain('--continue');

      await expect(runner.end(s.id)).rejects.toThrow(/uncommitted changes/);
      await runner.end(s.id, { force: true });
      expect(await exists(wt)).toBe(false);
      expect(await exists(dirname(wt))).toBe(false);
      expect(await exists(configDir)).toBe(false);
      expect(await tmux.list('loop-it')).toEqual([]);
      expect((await git(repo, 'worktree', 'list')).stdout.trim().split('\n')).toHaveLength(1);
      expect((await git(repo, 'branch', '--list', s.branch)).stdout).toContain(s.branch);
    },
  );
  it(
    'runs a folder project in place: cwd is the folder, only .loop/ is added, end() leaves the files',
    { timeout: 30_000 },
    async () => {
      const root = await realpath(dir);
      const folder = join(root, 'notes');
      await mkdir(join(folder, 'sub'), { recursive: true });
      await writeFile(join(folder, 'resume.md'), '# Resume\n');
      await writeFile(join(folder, 'sub', 'draft.txt'), 'draft\n');
      const cwdOut = join(root, 'folder-agent-cwd.txt');
      const fakeClaude = join(root, 'fake-claude-folder.sh');
      await writeFile(
        fakeClaude,
        ['#!/bin/sh', `pwd -P > '${cwdOut}'`, 'echo "FOLDER AGENT up"', 'exec sleep 300', ''].join('\n'),
        { mode: 0o755 },
      );
      const snapshot = async () => {
        const out: Record<string, string> = {};
        const walk = async (d: string): Promise<void> => {
          for (const e of await readdir(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) {
              out[`${p}/`] = '';
              await walk(p);
            } else {
              const st = await stat(p);
              out[p] = `${await readFile(p, 'utf8')}|${st.mtimeMs}|${st.mode}`;
            }
          }
        };
        await walk(folder);
        return out;
      };
      const original = await snapshot();
      const tmux = new RealTmuxDriver({ socketName: SOCKET });
      const runner = new SessionRunner(
        {
          store,
          tmux,
          git: new RealGitDriver(),
          fs: nodeFs,
          agentCli: new DefaultAgentCli({ claude: fakeClaude, opencode: fakeClaude }),
          log: () => undefined,
        },
        {
          worktreesRoot: join(root, 'worktrees'),
          serverUrl: 'http://127.0.0.1:1',
          tmuxSession: 'loop-folder-it',
          env: { MCP_TOKEN: 'test-token' },
          claudeProjectsDir: join(root, 'claude-projects'),
        },
      );
      const project = store.projects.create({ name: 'notes', kind: 'folder', folderPath: folder });
      const s = await runner.startSession(project.id, { text: 'Update my resume' });
      expect(s).toMatchObject({ branch: '', worktrees: [] });
      expect((await waitFor('the folder agent cwd', () => readFile(cwdOut, 'utf8'))).trim()).toBe(folder);
      await waitFor('the folder agent output', async () =>
        (await tmux.capture(s.tmuxTarget ?? '')).includes('FOLDER AGENT up'),
      );
      // Starting wrote nothing into the folder.
      expect(await snapshot()).toEqual(original);
      await expect(runner.startSession(project.id, { text: 'again' })).rejects.toThrow(/folder busy/);
      await runner.deliverFile(s.id, 'request-1.md', '# more', 'Read .loop/request-1.md');
      const withLoop = await snapshot();
      expect(
        Object.keys(withLoop)
          .filter((p) => !(p in original))
          .sort(),
      ).toEqual([
        join(folder, '.loop/'),
        join(folder, '.loop/.gitignore'),
        join(folder, '.loop/request-1.md'),
      ]);
      expect(await readFile(join(folder, '.loop/.gitignore'), 'utf8')).toBe('*\n');
      await runner.end(s.id);
      expect(store.sessions.require(s.id).status).toBe('ended');
      // end() touched nothing in the folder: same files, contents, mtimes and modes, .loop/ included.
      expect(await snapshot()).toEqual(withLoop);
      expect(await exists(join(root, 'worktrees/.loop-runner', `s${s.id}`))).toBe(false);
      expect(await tmux.list('loop-folder-it')).toEqual([]);
    },
  );
});
