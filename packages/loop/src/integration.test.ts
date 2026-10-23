// The loop end to end against a real local git repo with a bare "remote", fake gh/claude/opencode/
// vercel executables first on PATH, a real SessionRunner (real git, FakeTmux) and the real CLI
// adapters. Nothing here reaches GitHub, Claude, OpenCode or Vercel.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { FakeTimers, QuestionBus, QuestionService } from '@loop-engineering/ask-human';
import { FakeClock, openStore, type Project, type Store } from '@loop-engineering/core';
import {
  DefaultAgentCli,
  FakeTmuxDriver,
  nodeFs,
  RealGitDriver,
  SessionRunner,
} from '@loop-engineering/runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliAgentLauncher } from './agent.js';
import { LoopEngine } from './engine.js';
import { GhCli, GhDeployments } from './gh.js';
import { loopState } from './state.js';
import { writeFakeBins } from './test-support/fake-bins.js';
import { GitWorkspace } from './workspace.js';

const run = promisify(execFile);
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

interface GhState {
  remote: string;
  next: number;
  prs: {
    number: number;
    state: string;
    headRefName: string;
    comments: { body: string }[];
    mergeCommit?: string;
  }[];
  deploy: { state: string; description: string };
  deployIds: Record<string, number>;
}

describe('PR loop with a real git remote and fake CLIs', () => {
  let dir: string;
  let store: Store;
  let env: Record<string, string>;
  let remote: string;
  let repo: string;
  let project: Project;
  let runner: SessionRunner;
  let tmux: FakeTmuxDriver;
  let engine: LoopEngine;

  const git = (cwd: string, ...args: string[]) =>
    run('git', ['-C', cwd, '-c', 'user.name=Builder', '-c', 'user.email=b@test.invalid', ...args]).then((r) =>
      r.stdout.trim(),
    );
  const ghState = async () => JSON.parse(await readFile(env.FAKE_GH_STATE!, 'utf8')) as GhState;
  const setDeploy = async (deploy: GhState['deploy']) => {
    const s = await ghState();
    await writeFile(env.FAKE_GH_STATE!, JSON.stringify({ ...s, deploy }));
  };
  const log = async () => (await readFile(env.FAKE_LOG!, 'utf8').catch(() => '')).split('\n').filter(Boolean);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loop-it-'));
    const bin = join(dir, 'bin');
    await writeFakeBins(bin);
    env = {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      FAKE_GH_STATE: join(dir, 'gh-state.json'),
      FAKE_LOG: join(dir, 'calls.log'),
    };
    remote = join(dir, 'remote.git');
    repo = join(dir, 'repo');
    await run('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    await run('git', ['init', '-q', '-b', 'main', repo]);
    await writeFile(join(repo, 'README.md'), '# shop\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'Initial commit');
    await git(repo, 'remote', 'add', 'origin', remote);
    await git(repo, 'push', '-q', 'origin', 'main');
    await writeFile(
      env.FAKE_GH_STATE!,
      JSON.stringify({
        remote,
        next: 1,
        prs: [],
        deploy: { state: 'success', description: '' },
        deployIds: {},
      } satisfies GhState),
    );

    const clock = new FakeClock('2026-10-18T09:00:00.000Z');
    store = openStore({ clock });
    project = store.projects.create({
      name: 'Shop',
      autoMerge: true,
      repos: [{ name: 'web', path: repo, remote, defaultBranch: 'main', vercelProject: 'web' }],
    });
    tmux = new FakeTmuxDriver();
    runner = new SessionRunner(
      {
        store,
        tmux,
        git: new RealGitDriver(),
        fs: nodeFs,
        agentCli: new DefaultAgentCli(),
        log: () => undefined,
      },
      {
        worktreesRoot: join(dir, 'wt'),
        serverUrl: 'http://127.0.0.1:1',
        claudeProjectsDir: join(dir, 'claude'),
        env: { MCP_TOKEN: 'tok' },
      },
    );
    const questions = new QuestionService(store, new QuestionBus());
    engine = new LoopEngine(
      {
        store,
        runner,
        questions,
        github: new GhCli({ env }),
        // The server's environment has secrets; jobs must get none of them.
        launcher: new CliAgentLauncher({
          sourceEnv: {
            ...process.env,
            PATH: env.PATH,
            DASHBOARD_TOKEN: 'secret-dashboard',
            GH_TOKEN: 'secret-gh',
          },
          extraEnv: { FAKE_GH_STATE: env.FAKE_GH_STATE!, FAKE_LOG: env.FAKE_LOG! },
          ghConfigDir: join(dir, 'gh-empty'),
        }),
        deployments: new GhDeployments({ env }),
        workspace: new GitWorkspace(join(dir, 'jobs')),
        timers: new FakeTimers(clock),
        log: () => undefined,
      },
      { maxConcurrentJobs: 1 },
    );
  });

  afterEach(async () => {
    await engine.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** The builder agent's work, done by hand: commit in the session worktree, push, open the PR. */
  async function build(worktree: string, branch: string, content: string, open = false) {
    await writeFile(join(worktree, 'pay.txt'), content);
    await git(worktree, 'add', 'pay.txt');
    await git(worktree, 'commit', '-q', '-m', 'Pay page');
    await git(worktree, 'push', '-q', 'origin', branch);
    if (open)
      await run(
        'gh',
        ['pr', 'create', '--head', branch, '--title', 'Add a pay page', '--body', 'Adds pay.txt'],
        { env: { ...process.env, ...env } },
      );
  }

  it(
    'review comments → fix → review → tester adds tests → squash merge → failed deploy → revert + fix session → cleanup',
    { timeout: 60_000 },
    async () => {
      const session = await runner.startSession(project.id, { text: 'Add a pay page' });
      const worktree = session.worktrees[0]!.path;
      await build(worktree, session.branch, 'pay\n', true);
      await setDeploy({ state: 'failure', description: 'Build failed: Cannot find module "stripe"' });

      await engine.tick();
      const pr = store.pullRequests.getByNumber(project.id, 'web', 1)!;
      // The tester's tests ran first (round 1) and the loop pushed them; the reviewer of round 2
      // is seen blocking, because the fake reviewer has not seen a null check yet.
      expect(pr).toMatchObject({ sessionId: session.id, stage: 'review', round: 2 });
      // The loop posted the reviewer's comment and handed the builder a file plus a fixed sentence.
      expect((await ghState()).prs[0]?.comments.map((c) => c.body)).toEqual([
        expect.stringContaining('- [blocking] pay.txt:1 - add a null check'),
      ]);
      const window = tmux.windows.get(store.sessions.require(session.id).tmuxTarget!)!;
      const file = `.loop/pr${pr.id}-round2-review.md`;
      expect(window.keys).toBe(`New review feedback for PR #1 is in ${file}. Read it and address it.\n`);
      expect(await readFile(join(worktree, file), 'utf8')).toContain('1. pay.txt:1 - add a null check');
      expect(await git(worktree, 'status', '--porcelain')).toBe(''); // .loop/ is git-excluded

      await engine.tick(); // no push yet
      expect((await log()).filter((l) => l.startsWith('claude'))).toHaveLength(2); // tests, then review

      // The loop pushed the tester's tests onto the branch in round 1, so the builder pulls first
      // (as the feedback file's own instructions say).
      await git(worktree, 'pull', '-q', '--rebase', 'origin', session.branch);
      await build(worktree, session.branch, 'pay with a null check\n');
      await engine.tick();
      await engine.tick(); // the revert PR's own cleanup

      // Round 2 passed review; the builder's fix was tested again, and round 3 reviewed it too.
      const done = store.pullRequests.require(pr.id);
      expect(done).toMatchObject({ round: 3, stage: 'reverted', outcome: 'reverted' });
      const revert = store.pullRequests.require(done.revertedByPrId!);
      expect(revert).toMatchObject({ number: 2, outcome: 'merged' });

      // The tester's test was committed by the loop (as the git user), not the job.
      const branchLog = await git(remote, 'log', '--format=%s', loopState(done).mergedHeadSha!);
      expect(branchLog.split('\n')).toContain('Add tests for PR #1 (loop-engineering tester)');

      // The squash merge (with the added test) and its revert both landed on the remote's main.
      const subjects = (await git(remote, 'log', '--format=%s', 'main')).split('\n');
      expect(subjects.slice(0, 2)).toEqual(['Revert PR #1: deploy failed (#2)', 'Add a pay page (#1)']);
      expect(await git(remote, 'show', `${done.mergeCommitSha}:pay.test.txt`)).toBe('tests pay.txt');
      await expect(git(remote, 'show', 'main:pay.txt')).rejects.toThrow();

      // Cleanup: remote branch (at the merged head) and local branch (all merged) gone, session ended.
      await expect(git(remote, 'rev-parse', '--verify', `refs/heads/${session.branch}`)).rejects.toThrow();
      await expect(git(repo, 'rev-parse', '--verify', `refs/heads/${session.branch}`)).rejects.toThrow();
      expect(loopState(done).cleanup).toEqual({
        remoteBranch: 'deleted',
        session: 'ended',
        localBranch: { web: 'deleted' },
      });
      expect(store.sessions.require(session.id).status).toBe('ended');
      expect(await exists(worktree)).toBe(false);
      expect(await exists(join(dir, 'jobs', `pr${pr.id}-review`))).toBe(false);

      // The fix request is recorded for the router; the loop starts no session.
      const fix = store.requests.require(loopState(done).fixRequestId!);
      expect(fix.text).toMatch(
        /^\[loop\] Fix deploy failure of PR #1: Vercel Production – web deploy failed; Build failed: Cannot find module "stripe"/,
      );
      expect(fix.sessionId).toBeNull();

      // Jobs ran through the real launcher with their rights and a scrubbed environment.
      const calls = await log();
      const claude = calls.filter((l) => l.startsWith('claude '));
      expect(claude).toHaveLength(4); // tests ×2, review ×2 (its pushed tests are not run twice)
      expect(claude[0]).toContain('"--setting-sources","user"');
      // The reviewer may only read files: no shell, no gh.
      expect(claude[1]).toContain('"--allowedTools","Read","Grep","Glob","LS","--disallowedTools"');
      expect(claude[1]).toMatch(/"--disallowedTools",.*"Bash"\]/);
      expect(claude.every((l) => l.includes('"DASHBOARD_TOKEN":null,"GH_TOKEN":null'))).toBe(true);
      expect(claude[1]).toContain(`"GH_CONFIG_DIR":"${join(dir, 'gh-empty')}"`);
      expect(calls.filter((l) => l.startsWith('opencode') || l.startsWith('vercel'))).toEqual([]);
      expect(store.metrics.get(pr.id)).toMatchObject({ tokensIn: 400, tokensOut: 40, rounds: 3 });
      expect(store.metrics.get(pr.id).costUsd).toBeCloseTo(0.2);
    },
  );

  it(
    'keeps a remote branch that moved after the merge and a local branch with unmerged commits',
    { timeout: 60_000 },
    async () => {
      const session = await runner.startSession(project.id, { text: 'Add a pay page' });
      const worktree = session.worktrees[0]!.path;
      await build(worktree, session.branch, 'pay with a null check\n', true);
      const workspace = new GitWorkspace(join(dir, 'jobs'));
      const repoRow = project.repos[0]!;
      const pushed = await git(worktree, 'rev-parse', 'HEAD');
      // An unpushed local commit after the PR head.
      await writeFile(join(worktree, 'later.txt'), 'later\n');
      await git(worktree, 'add', 'later.txt');
      await git(worktree, 'commit', '-q', '-m', 'Later work');
      await git(worktree, 'push', '-q', 'origin', `HEAD:refs/heads/other`);
      await runner.end(session.id);
      expect(await workspace.deleteLocalBranch(repoRow, session.branch, pushed)).toBe('kept');
      await expect(git(repo, 'rev-parse', '--verify', `refs/heads/${session.branch}`)).resolves.toBeTruthy();
      // The remote branch: refused at a different sha, deleted at its own, then gone.
      expect(await workspace.deleteRemoteBranch(repoRow, session.branch, 'a'.repeat(40))).toBe('moved');
      expect(await workspace.deleteRemoteBranch(repoRow, session.branch, pushed)).toBe('deleted');
      expect(await workspace.deleteRemoteBranch(repoRow, session.branch, pushed)).toBe('gone');
      // Once every local commit is in the merged head, the local branch goes.
      const tip = await git(repo, 'rev-parse', `refs/heads/${session.branch}`);
      expect(await workspace.deleteLocalBranch(repoRow, session.branch, tip)).toBe('deleted');
      expect(await workspace.deleteLocalBranch(repoRow, session.branch, tip)).toBe('gone');
    },
  );

  it('a clean PR is merged and its deploy watched to success', { timeout: 60_000 }, async () => {
    const session = await runner.startSession(project.id, { text: 'Add a pay page' });
    await build(session.worktrees[0]!.path, session.branch, 'pay with a null check\n', true);
    await engine.tick();
    const pr = store.pullRequests.getByNumber(project.id, 'web', 1)!;
    expect(pr).toMatchObject({ stage: 'deployed', outcome: 'merged', round: 2 }); // round 2 reviewed the added test
    expect(await git(remote, 'rev-parse', 'main')).toBe(pr.mergeCommitSha);
    expect(loopState(pr)).toMatchObject({ done: true, cleanup: { session: 'ended' } });
  });
});
