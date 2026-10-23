import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { NotFoundError, ValidationError } from './errors.js';
import { openStore, type Store } from './store.js';
import type { GuardianAreaResult, Project } from './types.js';

let clock: FakeClock;
let store: Store;
let project: Project;

beforeEach(() => {
  clock = new FakeClock('2026-10-18T09:00:00.000Z');
  store = openStore({ clock });
  project = store.projects.create({
    name: 'shop',
    repos: [
      {
        name: 'web',
        path: '/src/web',
        remote: 'git@github.com:me/web.git',
        defaultBranch: 'main',
        vercelProject: 'web',
      },
      { name: 'api', path: '/src/api', remote: 'git@github.com:me/api.git', defaultBranch: 'main' },
    ],
    envFiles: [{ repo: 'web', source: '/secrets/web.env', target: '.env.local' }],
  });
  return () => store.close();
});

describe('settings', () => {
  it('keeps at least one agent CLI on', () => {
    expect(store.settings.update({ claudeEnabled: false })).toMatchObject({
      claudeEnabled: false,
      opencodeEnabled: true,
    });
    expect(() => store.settings.update({ opencodeEnabled: false })).toThrow(ValidationError);
    expect(store.settings.update({ claudeEnabled: true, opencodeEnabled: false })).toMatchObject({
      opencodeEnabled: false,
    });
  });

  it('has defaults and updates partially', () => {
    expect(store.settings.get()).toEqual({
      sessionModel: 'opus',
      fallbackModel: 'opencode/glm-5.3-flash-free',
      telegramAllowlist: [],
      claudeEnabled: true,
      opencodeEnabled: true,
      opencodeBackupModels: [
        'opencode/deepseek-v4.1-flash-free',
        'opencode/big-pickle',
        'opencode/nemotron-3-ultra-free',
        'opencode/mimo-v2.6-flash-free',
      ],
    });
    expect(store.settings.update({ telegramAllowlist: [11, 22, 11] })).toEqual({
      sessionModel: 'opus',
      fallbackModel: 'opencode/glm-5.3-flash-free',
      telegramAllowlist: [11, 22],
      claudeEnabled: true,
      opencodeEnabled: true,
      opencodeBackupModels: [
        'opencode/deepseek-v4.1-flash-free',
        'opencode/big-pickle',
        'opencode/nemotron-3-ultra-free',
        'opencode/mimo-v2.6-flash-free',
      ],
    });
    expect(store.settings.update({}).telegramAllowlist).toEqual([11, 22]);
    expect(store.settings.update({ sessionModel: 'fable' }).sessionModel).toBe('fable');
  });

  it("stores the router's reserved session id, cleared when that session is deleted", () => {
    expect(store.settings.getRouterSessionId()).toBeNull();
    const reserved = store.projects.create({ name: 'reserved' });
    const session = store.sessions.create({ projectId: reserved.id, title: 'r', model: 'none', branch: 'r' });
    store.settings.setRouterSessionId(session.id);
    expect(store.settings.getRouterSessionId()).toBe(session.id);
    expect(store.settings.get()).not.toHaveProperty('routerSessionId');
    store.projects.delete(reserved.id);
    expect(store.settings.getRouterSessionId()).toBeNull();
  });

  it('rejects bad values', () => {
    expect(() => store.settings.update({ fallbackModel: ' ' })).toThrow(ValidationError);
    expect(() => store.settings.update({ sessionModel: '' })).toThrow(ValidationError);
    expect(() => store.settings.update({ telegramAllowlist: [1.5] })).toThrow(ValidationError);
  });
});

describe('projects', () => {
  it('creates with defaults and reads back', () => {
    expect(project).toMatchObject({
      name: 'shop',
      autoMerge: false,
      markedForDirectInput: false,
      createdAt: '2026-10-18T09:00:00.000Z',
    });
    expect(store.projects.get(project.id)).toEqual(project);
    expect(store.projects.getByName('shop')).toEqual(project);
    expect(store.projects.get(999)).toBeUndefined();
  });

  it('lists, filters, updates and deletes', () => {
    const other = store.projects.create({ name: 'blog', markedForDirectInput: true });
    expect(store.projects.list().map((p) => p.name)).toEqual(['blog', 'shop']);
    expect(store.projects.list({ markedForDirectInput: true })).toEqual([other]);

    const updated = store.projects.update(project.id, { autoMerge: true, envFiles: [] });
    expect(updated.autoMerge).toBe(true);
    expect(updated.envFiles).toEqual([]);
    expect(updated.repos).toHaveLength(2);

    expect(store.projects.delete(other.id)).toBe(true);
    expect(store.projects.delete(other.id)).toBe(false);
    expect(() => store.projects.update(other.id, { autoMerge: true })).toThrow(NotFoundError);
  });

  it('validates repos and env files', () => {
    const repo = { name: 'a', path: '/a', remote: 'r', defaultBranch: 'main' };
    expect(() => store.projects.create({ name: 'x', repos: [repo, repo] })).toThrow(/duplicate repo/);
    expect(() =>
      store.projects.create({ name: 'x', envFiles: [{ repo: 'nope', source: '/e', target: '.env' }] }),
    ).toThrow(/unknown repo/);
    expect(() => store.projects.create({ name: 'shop' })).toThrow(/UNIQUE/);
    expect(() => store.projects.update(project.id, { repos: [] })).toThrow(/unknown repo/);
  });

  it('refuses to remove a repo still used by a live session or open PR', () => {
    const [web, api] = project.repos as [Project['repos'][number], Project['repos'][number]];
    const session = store.sessions.create({
      projectId: project.id,
      title: 's',
      model: 'm',
      branch: 'b',
      worktrees: [{ repo: 'api', path: '/wt/api' }],
    });
    const pr = store.pullRequests.create({ projectId: project.id, repo: 'web', number: 1, url: 'u' });
    const keepEnvFiles = { envFiles: [] };
    expect(() => store.projects.update(project.id, { ...keepEnvFiles, repos: [web] })).toThrow(
      /session worktree/,
    );
    expect(() => store.projects.update(project.id, { ...keepEnvFiles, repos: [api] })).toThrow(
      /open pull request/,
    );
    store.sessions.end(session.id);
    store.pullRequests.update(pr.id, { outcome: 'closed' });
    expect(store.projects.update(project.id, { ...keepEnvFiles, repos: [] }).repos).toEqual([]);
  });

  it('cascades deletes to sessions, PRs, metrics and history', () => {
    const session = store.sessions.create({ projectId: project.id, title: 's', model: 'opus', branch: 'b' });
    const pr = store.pullRequests.create({ projectId: project.id, repo: 'web', number: 1, url: 'u' });
    store.metrics.record(pr.id, { failures: 1 });
    store.history.add({ projectId: project.id, sessionId: session.id, kind: 'decision', text: 'use sqlite' });

    store.projects.delete(project.id);
    expect(store.sessions.get(session.id)).toBeUndefined();
    expect(store.pullRequests.get(pr.id)).toBeUndefined();
    expect(store.metrics.list()).toEqual([]);
    expect(store.history.search('sqlite')).toEqual([]);
  });
});

describe('project inputs used in paths and git arguments', () => {
  const repo = { name: 'web', path: '/src/web', remote: 'r', defaultBranch: 'main' };

  it.each(['..', '.', '.hidden', 'a/b', 'a/../../x', '-rf', 'has space', 'x#y'])(
    'rejects repo name %j',
    (name) => {
      expect(() => store.projects.create({ name: `p-${name}`, repos: [{ ...repo, name }] })).toThrow(
        ValidationError,
      );
    },
  );

  it.each(['-main', 'a..b', 'feat/', '/main', 'x.lock', 'a.lock/b', 'a//b', 'feat/.x', 'a b', 'x.', '@'])(
    'rejects branch %j',
    (b) => {
      expect(() => store.projects.create({ name: 'p', repos: [{ ...repo, defaultBranch: b }] })).toThrow(
        ValidationError,
      );
    },
  );

  it.each(['/etc/passwd', '../x', 'a/../../x', './.env', '', 'a//b'])('rejects env target %j', (target) => {
    expect(() =>
      store.projects.create({ name: 'p', repos: [repo], envFiles: [{ repo: 'web', source: '/s', target }] }),
    ).toThrow(ValidationError);
  });

  it('accepts ordinary values', () => {
    const p = store.projects.create({
      name: 'ok',
      repos: [{ ...repo, name: 'my.repo_2-x', defaultBranch: 'release/2026-10' }],
      envFiles: [{ repo: 'my.repo_2-x', source: '/s', target: 'config/.env.local' }],
    });
    expect(p.repos[0]?.name).toBe('my.repo_2-x');
  });
});

describe('folder projects', () => {
  it('stores kind and folderPath; git is the default', () => {
    expect(store.projects.require(project.id)).toMatchObject({ kind: 'git', folderPath: null });
    const notes = store.projects.create({
      name: 'notes',
      kind: 'folder',
      folderPath: '/home/me/notes',
      autoMerge: true,
      markedForDirectInput: true,
    });
    expect(notes).toMatchObject({ kind: 'folder', folderPath: '/home/me/notes', repos: [], envFiles: [] });
    expect(store.projects.list({ markedForDirectInput: true }).map((p) => p.name)).toContain('notes');
  });

  it('checks the shape: a folder project has a normalized absolute folder and no repos or env files', () => {
    const repo = { name: 'web', path: '/src/web', remote: 'r', defaultBranch: 'main' };
    const folder = (extra: object) => () =>
      store.projects.create({ name: 'f', kind: 'folder', ...extra } as never);
    expect(folder({})).toThrow(/needs a folderPath/);
    for (const bad of ['rel/path', '/a/../b', '/a/', '/a//b'])
      expect(folder({ folderPath: bad })).toThrow(/absolute, normalized/);
    expect(folder({ folderPath: '/a', repos: [repo] })).toThrow(/no repos/);
    expect(folder({ folderPath: '/a', envFiles: [{ repo: 'web', source: '/s', target: '.env' }] })).toThrow();
    expect(() => store.projects.create({ name: 'g', folderPath: '/a' })).toThrow(/only a folder project/);
    expect(() => store.projects.create({ name: 'k', kind: 'svn' as never })).toThrow(/unknown project kind/);
    store.projects.create({ name: 'f1', kind: 'folder', folderPath: '/a' });
    expect(folder({ folderPath: '/a' })).toThrow(/already uses the folder/);
  });

  it('never changes kind or folderPath, and keeps a folder project free of repos', () => {
    const notes = store.projects.create({ name: 'notes', kind: 'folder', folderPath: '/home/me/notes' });
    expect(() => store.projects.update(notes.id, { kind: 'git' } as never)).toThrow(/kind cannot be changed/);
    expect(() => store.projects.update(notes.id, { folderPath: '/x' } as never)).toThrow(/folderPath cannot/);
    expect(() =>
      store.projects.update(notes.id, {
        repos: [{ name: 'web', path: '/src/web', remote: 'r', defaultBranch: 'main' }],
      }),
    ).toThrow(/no repos/);
    expect(store.projects.update(notes.id, { autoMerge: true, name: 'Notes' })).toMatchObject({
      name: 'Notes',
      kind: 'folder',
      folderPath: '/home/me/notes',
      autoMerge: true,
    });
  });
});

describe('project permission mode', () => {
  it('defaults to auto, is selectable, and rejects unknown modes', () => {
    expect(project.permissionMode).toBe('auto');
    for (const mode of ['manual', 'acceptEdits', 'plan', 'bypassPermissions'] as const) {
      expect(store.projects.update(project.id, { permissionMode: mode }).permissionMode).toBe(mode);
    }
    expect(store.projects.create({ name: 'm', permissionMode: 'manual' }).permissionMode).toBe('manual');
    expect(() => store.projects.update(project.id, { permissionMode: 'yolo' as 'auto' })).toThrow(
      ValidationError,
    );
  });
});

describe('sessions', () => {
  it('creates with defaults', () => {
    const session = store.sessions.create({
      projectId: project.id,
      title: 'Add checkout',
      model: 'claude-opus-5-5',
      branch: 'feat/checkout',
      worktrees: [{ repo: 'web', path: '/wt/web' }],
    });
    expect(session).toEqual({
      id: session.id,
      projectId: project.id,
      title: 'Add checkout',
      status: 'active',
      provider: 'claude',
      model: 'claude-opus-5-5',
      effort: null,
      pauseReason: null,
      tmuxTarget: null,
      agentSessionId: null,
      branch: 'feat/checkout',
      worktrees: [{ repo: 'web', path: '/wt/web' }],
      source: 'runner',
      createdAt: '2026-10-18T09:00:00.000Z',
      endedAt: null,
    });
  });

  it('updates, ends and reopens', () => {
    const s = store.sessions.create({ projectId: project.id, title: 't', model: 'm', branch: 'b' });
    expect(store.sessions.update(s.id, { provider: 'opencode', tmuxTarget: 'le:1.0' })).toMatchObject({
      provider: 'opencode',
      tmuxTarget: 'le:1.0',
    });
    clock.advance(60_000);
    expect(store.sessions.end(s.id)).toMatchObject({ status: 'ended', endedAt: '2026-10-18T09:01:00.000Z' });
    clock.advance(60_000);
    // Ending twice keeps the first timestamp.
    expect(store.sessions.end(s.id).endedAt).toBe('2026-10-18T09:01:00.000Z');
    expect(store.sessions.update(s.id, { status: 'active' }).endedAt).toBeNull();
  });

  it('lists by project and status, newest first', () => {
    const a = store.sessions.create({ projectId: project.id, title: 'a', model: 'm', branch: 'a' });
    const b = store.sessions.create({
      projectId: project.id,
      title: 'b',
      model: 'm',
      branch: 'b',
      status: 'paused',
    });
    const c = store.sessions.create({
      projectId: project.id,
      title: 'c',
      model: 'm',
      branch: 'c',
      status: 'ended',
    });
    expect(c.endedAt).not.toBeNull();
    expect(store.sessions.list({ projectId: project.id }).map((s) => s.id)).toEqual([c.id, b.id, a.id]);
    expect(store.sessions.list({ status: ['active', 'paused'] }).map((s) => s.id)).toEqual([b.id, a.id]);
    expect(store.sessions.list({ status: [] })).toEqual([]);
  });

  it('validates worktrees against the project repos', () => {
    const base = { projectId: project.id, title: 't', model: 'm', branch: 'b' };
    expect(() => store.sessions.create({ ...base, worktrees: [{ repo: 'mobile', path: '/x' }] })).toThrow(
      ValidationError,
    );
    expect(() =>
      store.sessions.create({
        ...base,
        worktrees: [
          { repo: 'web', path: '/x' },
          { repo: 'web', path: '/y' },
        ],
      }),
    ).toThrow(/more than one worktree/);
    expect(() => store.sessions.create({ ...base, projectId: 999 })).toThrow(NotFoundError);
    expect(() => store.sessions.create({ ...base, status: 'bogus' as 'active' })).toThrow(/CHECK/);
  });
});

describe('imported sessions', () => {
  const past = {
    title: 'Fix the checkout bug',
    model: 'claude-opus-4-1',
    agentSessionId: '11111111-2222-4333-8444-555555555555',
    createdAt: '2026-09-01T09:00:00Z',
    endedAt: '2026-09-01T11:30:00.000Z',
  };

  it('stores a past conversation as ended, with its own times and no branch or worktrees', () => {
    const s = store.sessions.importEnded({ projectId: project.id, ...past });
    expect(s).toMatchObject({
      status: 'ended',
      source: 'import',
      provider: 'claude',
      model: 'claude-opus-4-1',
      agentSessionId: past.agentSessionId,
      branch: '',
      worktrees: [],
      tmuxTarget: null,
      pauseReason: null,
      createdAt: '2026-09-01T09:00:00.000Z',
      endedAt: '2026-09-01T11:30:00.000Z',
    });
    expect(store.sessions.list({ source: 'import' })).toEqual([s]);
    expect(store.sessions.list({ source: 'runner' })).toEqual([]);
    expect(store.sessions.findByAgentSessionId(past.agentSessionId, project.id)).toEqual([s]);
  });

  it('imports a conversation once per project', () => {
    expect(store.sessions.importEnded({ projectId: project.id, ...past })).not.toBeNull();
    expect(store.sessions.importEnded({ projectId: project.id, ...past, title: 'again' })).toBeNull();
    expect(store.sessions.list()).toHaveLength(1);
    const other = store.projects.create({ name: 'other' });
    expect(store.sessions.importEnded({ projectId: other.id, ...past })).not.toBeNull();
  });

  it('stays ended and validates its times', () => {
    const s = store.sessions.importEnded({ projectId: project.id, ...past })!;
    expect(() => store.sessions.update(s.id, { status: 'active' })).toThrow(ValidationError);
    expect(store.sessions.update(s.id, { title: 'renamed' }).title).toBe('renamed');
    expect(() =>
      store.sessions.importEnded({
        projectId: project.id,
        ...past,
        agentSessionId: 'b',
        endedAt: '2026-08-01T00:00:00Z',
      }),
    ).toThrow(/before createdAt/);
    expect(() =>
      store.sessions.importEnded({
        projectId: project.id,
        ...past,
        agentSessionId: 'c',
        createdAt: 'yesterday',
      }),
    ).toThrow(ValidationError);
    expect(() => store.sessions.importEnded({ projectId: 999, ...past })).toThrow(NotFoundError);
  });
});

describe('session handles and pausing', () => {
  it('round-trips the agent conversation id', () => {
    const s = store.sessions.create({
      projectId: project.id,
      title: 't',
      model: 'm',
      branch: 'b',
      agentSessionId: 'conv-1',
    });
    expect(s.agentSessionId).toBe('conv-1');
    expect(store.sessions.update(s.id, { agentSessionId: null }).agentSessionId).toBeNull();
  });

  it('records why a session is paused and clears it on resume', () => {
    const s = store.sessions.create({ projectId: project.id, title: 't', model: 'm', branch: 'b' });
    expect(store.sessions.update(s.id, { status: 'paused', pauseReason: 'usage_limit' }).pauseReason).toBe(
      'usage_limit',
    );
    // Re-pausing without a reason keeps the original one.
    expect(store.sessions.update(s.id, { status: 'paused' }).pauseReason).toBe('usage_limit');
    expect(store.sessions.update(s.id, { status: 'active' }).pauseReason).toBeNull();
    expect(store.sessions.update(s.id, { status: 'paused' }).pauseReason).toBe('manual');
    expect(store.sessions.update(s.id, { pauseReason: 'agent_exited' }).pauseReason).toBe('agent_exited');
    expect(store.sessions.end(s.id).pauseReason).toBeNull();
    expect(() => store.sessions.update(s.id, { pauseReason: 'manual' })).toThrow(ValidationError);
    expect(
      store.sessions.create({
        projectId: project.id,
        title: 't',
        model: 'm',
        branch: 'b',
        status: 'paused',
        pauseReason: 'usage_limit',
      }).pauseReason,
    ).toBe('usage_limit');
    expect(() =>
      store.sessions.create({
        projectId: project.id,
        title: 't',
        model: 'm',
        branch: 'b',
        pauseReason: 'manual',
      }),
    ).toThrow(ValidationError);
  });
});

describe('subagents', () => {
  it('creates, lists and updates', () => {
    const session = store.sessions.create({ projectId: project.id, title: 's', model: 'm', branch: 'b' });
    const sub = store.subagents.create({
      sessionId: session.id,
      title: 'Write tests',
      model: 'sonnet',
      effort: 'high',
    });
    expect(sub).toMatchObject({ status: 'running', effort: 'high', createdAt: '2026-10-18T09:00:00.000Z' });
    const other = store.subagents.create({
      sessionId: session.id,
      title: 'Docs',
      model: 'haiku',
      effort: 'low',
    });
    expect(store.subagents.update(other.id, { status: 'done' }).status).toBe('done');
    expect(store.subagents.list({ sessionId: session.id }).map((s) => s.id)).toEqual([sub.id, other.id]);
    expect(store.subagents.list({ status: 'running' })).toEqual([sub]);
    expect(() => store.subagents.update(999, { status: 'done' })).toThrow(NotFoundError);
    expect(() => store.subagents.create({ sessionId: 999, title: 'x', model: 'm', effort: 'low' })).toThrow(
      NotFoundError,
    );
    expect(() => store.subagents.create({ ...sub, effort: 'ultra' as 'max' })).toThrow(/CHECK/);
  });
});

describe('pull requests and metrics', () => {
  it('tracks a PR through the loop', () => {
    const pr = store.pullRequests.create({
      projectId: project.id,
      repo: 'api',
      number: 7,
      url: 'https://gh/7',
    });
    expect(pr).toMatchObject({ stage: 'tests', round: 0, outcome: null, sessionId: null });
    expect(store.pullRequests.getByNumber(project.id, 'api', 7)).toEqual(pr);

    clock.advance(1000);
    const moved = store.pullRequests.update(pr.id, { stage: 'tests', round: 2 });
    expect(moved).toMatchObject({ stage: 'tests', round: 2, updatedAt: '2026-10-18T09:00:01.000Z' });
    expect(moved.createdAt).toBe('2026-10-18T09:00:00.000Z');

    const done = store.pullRequests.create({ projectId: project.id, repo: 'web', number: 8, url: 'u' });
    store.pullRequests.update(done.id, { stage: 'deployed', outcome: 'merged' });
    expect(store.pullRequests.list({ open: true }).map((p) => p.id)).toEqual([pr.id]);
    expect(store.pullRequests.list({ open: false }).map((p) => p.id)).toEqual([done.id]);
    expect(store.pullRequests.list({ projectId: project.id, stage: ['tests', 'deployed'] })).toHaveLength(2);
  });

  it('rejects unknown repos and duplicate numbers', () => {
    const base = { projectId: project.id, number: 1, url: 'u' };
    expect(() => store.pullRequests.create({ ...base, repo: 'mobile' })).toThrow(ValidationError);
    store.pullRequests.create({ ...base, repo: 'web' });
    expect(() => store.pullRequests.create({ ...base, repo: 'web' })).toThrow(/UNIQUE/);
    expect(store.pullRequests.create({ ...base, repo: 'api' }).number).toBe(1);
  });

  it('accumulates metrics per PR and reads rounds from the PR', () => {
    const pr = store.pullRequests.create({ projectId: project.id, repo: 'web', number: 3, url: 'u' });
    expect(store.metrics.get(pr.id)).toEqual({
      prId: pr.id,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      rounds: 0,
      failures: 0,
    });
    store.metrics.record(pr.id, { costUsd: 0.25, tokensIn: 1000, tokensOut: 200 });
    store.pullRequests.update(pr.id, { round: 2 });
    const m = store.metrics.record(pr.id, { costUsd: 0.5, tokensIn: 500, failures: 1 });
    expect(m).toEqual({ prId: pr.id, costUsd: 0.75, tokensIn: 1500, tokensOut: 200, rounds: 2, failures: 1 });
    const untouched = store.pullRequests.create({ projectId: project.id, repo: 'web', number: 4, url: 'u' });
    expect(store.metrics.list({ projectId: project.id }).map((x) => x.prId)).toEqual([pr.id, untouched.id]);
    expect(store.metrics.list({ projectId: 999 })).toEqual([]);
    expect(() => store.metrics.record(pr.id, { costUsd: -1 })).toThrow(ValidationError);
    expect(() => store.metrics.record(pr.id, { costUsd: Infinity })).toThrow(ValidationError);
    expect(() => store.metrics.record(pr.id, { failures: 0.5 })).toThrow(ValidationError);
    expect(() => store.metrics.record(999, { failures: 1 })).toThrow(NotFoundError);
    expect(() => store.metrics.get(999)).toThrow(NotFoundError);
  });

  it('links requests, merge commits, reverts and follow-up fixes', () => {
    const session = store.sessions.create({ projectId: project.id, title: 's', model: 'm', branch: 'b' });
    const request = store.requests.create({
      projectId: project.id,
      sessionId: session.id,
      text: 'Add Apple Pay',
      source: 'telegram',
    });
    const pr = store.pullRequests.create({
      projectId: project.id,
      repo: 'web',
      number: 10,
      url: 'u',
      sessionId: session.id,
      requestId: request.id,
    });
    expect(pr).toMatchObject({
      requestId: request.id,
      mergeCommitSha: null,
      revertedByPrId: null,
      fixesPrId: null,
    });
    expect(store.pullRequests.list({ requestId: request.id }).map((p) => p.id)).toEqual([pr.id]);

    for (const stage of ['awaiting_approval', 'merge', 'deploying'] as const) {
      expect(store.pullRequests.update(pr.id, { stage }).stage).toBe(stage);
    }
    store.pullRequests.update(pr.id, { mergeCommitSha: 'abc123', outcome: 'merged' });
    const revert = store.pullRequests.create({ projectId: project.id, repo: 'web', number: 11, url: 'u' });
    const fix = store.pullRequests.create({
      projectId: project.id,
      repo: 'web',
      number: 12,
      url: 'u',
      fixesPrId: pr.id,
    });
    const reverted = store.pullRequests.update(pr.id, {
      stage: 'reverted',
      outcome: 'reverted',
      revertedByPrId: revert.id,
    });
    expect(reverted).toMatchObject({ mergeCommitSha: 'abc123', revertedByPrId: revert.id });
    expect(fix.fixesPrId).toBe(pr.id);

    expect(() => store.pullRequests.update(pr.id, { fixesPrId: pr.id })).toThrow(/itself/);
    expect(() => store.pullRequests.update(pr.id, { revertedByPrId: 999 })).toThrow(NotFoundError);
    expect(() => store.pullRequests.update(pr.id, { requestId: 999 })).toThrow(NotFoundError);
  });

  it('stores the loop state as a JSON object, empty by default', () => {
    const pr = store.pullRequests.create({ projectId: project.id, repo: 'web', number: 30, url: 'u' });
    expect(pr.loopState).toEqual({});
    const state = { v: 1, sha: 'abc', feedback: { items: ['fix x'], sentAt: null } };
    expect(store.pullRequests.update(pr.id, { loopState: state }).loopState).toEqual(state);
    expect(store.pullRequests.update(pr.id, { round: 2 }).loopState).toEqual(state);
  });

  it('rejects links into another project', () => {
    const other = store.projects.create({ name: 'other' });
    const foreignSession = store.sessions.create({
      projectId: other.id,
      title: 's',
      model: 'm',
      branch: 'b',
    });
    const foreignRequest = store.requests.create({ projectId: other.id, text: 'x', source: 'dashboard' });
    const base = { projectId: project.id, repo: 'web', url: 'u' };
    expect(() => store.pullRequests.create({ ...base, number: 1, sessionId: foreignSession.id })).toThrow(
      ValidationError,
    );
    expect(() => store.pullRequests.create({ ...base, number: 1, requestId: foreignRequest.id })).toThrow(
      ValidationError,
    );
    const pr = store.pullRequests.create({ ...base, number: 1 });
    expect(() => store.pullRequests.update(pr.id, { sessionId: foreignSession.id })).toThrow(ValidationError);
    expect(() =>
      store.history.add({ projectId: project.id, sessionId: foreignSession.id, kind: 'decision', text: 'x' }),
    ).toThrow(ValidationError);
    expect(() => store.history.add({ projectId: 999, kind: 'decision', text: 'x' })).toThrow(NotFoundError);
  });
});

describe('requests', () => {
  it('stores the original task and the session it was routed to', () => {
    const request = store.requests.create({
      projectId: project.id,
      text: 'Add dark mode',
      source: 'dashboard',
    });
    expect(request).toEqual({
      id: request.id,
      projectId: project.id,
      sessionId: null,
      targetSessionId: null,
      parentRequestId: null,
      text: 'Add dark mode',
      source: 'dashboard',
      createdAt: '2026-10-18T09:00:00.000Z',
    });
    const session = store.sessions.create({ projectId: project.id, title: 's', model: 'm', branch: 'b' });
    expect(store.requests.assignSession(request.id, session.id).sessionId).toBe(session.id);
    const second = store.requests.create({
      projectId: project.id,
      sessionId: session.id,
      text: 'Also RTL',
      source: 'telegram',
    });
    expect(store.requests.list({ sessionId: session.id }).map((r) => r.id)).toEqual([request.id, second.id]);
    expect(store.requests.list({ projectId: 999 })).toEqual([]);
  });

  it('stores the session a request is addressed to, which must be in its project', () => {
    const session = store.sessions.create({ projectId: project.id, title: 's', model: 'm', branch: 'b' });
    const request = store.requests.create({
      projectId: project.id,
      targetSessionId: session.id,
      text: 'One more thing',
      source: 'dashboard',
    });
    expect(request).toMatchObject({ targetSessionId: session.id, sessionId: null });
    expect(() =>
      store.requests.create({ text: 'x', source: 'dashboard', targetSessionId: session.id }),
    ).toThrow(ValidationError);
    const other = store.projects.create({ name: 'other' });
    expect(() =>
      store.requests.create({
        projectId: other.id,
        text: 'x',
        source: 'dashboard',
        targetSessionId: session.id,
      }),
    ).toThrow();
  });

  it('validates', () => {
    expect(() => store.requests.create({ projectId: project.id, text: ' ', source: 'telegram' })).toThrow(
      ValidationError,
    );
    expect(() => store.requests.create({ projectId: 999, text: 'x', source: 'telegram' })).toThrow(
      NotFoundError,
    );
    expect(() =>
      store.requests.create({ projectId: project.id, text: 'x', source: 'sms' as 'telegram' }),
    ).toThrow(/CHECK/);
    expect(() => store.requests.assignSession(999, 1)).toThrow(NotFoundError);
  });

  it('stores an unrouted request and routes it later', () => {
    const request = store.requests.create({ text: 'Fix the login bug', source: 'telegram' });
    expect(request).toMatchObject({ projectId: null, sessionId: null, source: 'telegram' });
    store.requests.create({ projectId: project.id, text: 'routed', source: 'dashboard' });
    expect(store.requests.list({ projectId: null }).map((r) => r.id)).toEqual([request.id]);
    expect(() => store.requests.create({ text: 'x', source: 'telegram', sessionId: 1 })).toThrow(
      ValidationError,
    );

    const other = store.projects.create({ name: 'other' });
    expect(store.requests.assignProject(request.id, project.id).projectId).toBe(project.id);
    expect(() => store.requests.assignProject(request.id, other.id)).toThrow(/already routed/);

    // assignSession on an unrouted request takes the session's project.
    const unrouted = store.requests.create({ text: 'Another', source: 'telegram' });
    const session = store.sessions.create({ projectId: other.id, title: 's', model: 'm', branch: 'b' });
    expect(store.requests.assignSession(unrouted.id, session.id)).toMatchObject({
      projectId: other.id,
      sessionId: session.id,
    });
    expect(store.requests.list({ projectId: null })).toEqual([]);
  });
});

describe('transaction', () => {
  it('rolls back everything when the callback throws', () => {
    expect(() =>
      store.transaction(() => {
        store.projects.create({ name: 'temp' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.projects.getByName('temp')).toBeUndefined();
    expect(store.transaction(() => store.projects.create({ name: 'kept' }).name)).toBe('kept');
  });

  it('rolls back only the inner part of a nested transaction', () => {
    store.transaction(() => {
      store.projects.create({ name: 'outer' });
      try {
        store.transaction(() => {
          store.projects.create({ name: 'inner' });
          throw new Error('inner fails');
        });
      } catch {
        // swallowed on purpose: the outer transaction carries on
      }
    });
    expect(store.projects.getByName('outer')).toBeDefined();
    expect(store.projects.getByName('inner')).toBeUndefined();
  });
});

describe('guardianRuns', () => {
  it('records a run, its result and filters by repo, PR and status', () => {
    const store = openStore({ clock: new FakeClock('2026-10-18T09:00:00.000Z') });
    const project = store.projects.create({
      name: 'Shop',
      repos: [{ name: 'web', path: '/src/web', remote: 'git@github.com:me/web.git', defaultBranch: 'main' }],
    });
    const run = store.guardianRuns.create({ projectId: project.id, repo: 'web', trigger: 'daily' });
    expect(run).toMatchObject({
      status: 'running',
      critical: false,
      areas: [],
      prId: null,
      finishedAt: null,
    });

    const areas: GuardianAreaResult[] = [
      { area: 'api', passed: false, critical: true, failures: ['500'], flaky: false, errored: false },
    ];
    const done = store.guardianRuns.update(run.id, {
      status: 'failed',
      critical: true,
      summary: 'api failed',
      areas,
      finished: true,
    });
    expect(done).toMatchObject({ status: 'failed', critical: true, finishedAt: '2026-10-18T09:00:00.000Z' });
    expect(done.areas).toEqual(areas);

    store.guardianRuns.create({ projectId: project.id, repo: 'web', trigger: 'daily' });
    expect(store.guardianRuns.list({ status: 'failed' }).map((r) => r.id)).toEqual([run.id]);
    expect(store.guardianRuns.list({ repo: 'web' }, 1).map((r) => r.id)).toEqual([2]);
    expect(() => store.guardianRuns.require(99)).toThrow(/guardian run 99/);
    store.close();
  });
});
