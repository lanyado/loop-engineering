import type { FakeClock } from '@loop-engineering/core';
import { describe, expect, it, vi } from 'vitest';
import { DefaultAgentCli } from './agent-cli.js';
import { UsageLimitMonitor, type MonitorOptions } from './monitor.js';
import { SessionRunner } from './runner.js';
import { harness } from './test-support/harness.js';

const MINUTE = 60_000;

async function setup(count = 1) {
  const h = harness();
  const clock = h.store.clock as FakeClock;
  const ids: number[] = [];
  for (let i = 0; i < count; i++)
    ids.push((await h.runner.startSession(h.shop.id, { text: `build ${i}` })).id);
  const onAlert = vi.fn();
  const launches = vi.spyOn(h.tmux, 'newWindow');
  const monitor = (runner = h.runner, options: MonitorOptions = {}) =>
    new UsageLimitMonitor(runner, h.store, {
      autoResume: true,
      now: () => clock.now().getTime(),
      onAlert,
      log: (m) => h.logs.push(m),
      ...options,
    });
  /** The agent's window goes away, as when its terminal closes. */
  const kill = (id: number) => h.tmux.windows.delete(h.store.sessions.require(id).tmuxTarget ?? '');
  const status = (id: number) => {
    const s = h.store.sessions.require(id);
    return s.status === 'paused' ? `paused:${s.pauseReason}` : s.status;
  };
  const tries = (id: number) =>
    h.store.history.list({ sessionId: id }).filter((e) => e.text.startsWith('Auto-resume:'));
  return { h, clock, ids, onAlert, launches, monitor, kill, status, tries };
}

describe('auto-resume of an agent that went away', () => {
  it('resumes after a minute, telling the agent what happened', async () => {
    const { h, clock, ids, monitor, kill, status, tries } = await setup();
    const [id] = ids as [number];
    const m = monitor();
    kill(id);
    await m.checkOnce();
    expect(status(id)).toBe('paused:agent_exited');
    clock.advance(59_000);
    await m.checkOnce();
    expect(status(id)).toBe('paused:agent_exited');
    clock.advance(2_000);
    await m.checkOnce();
    expect(status(id)).toBe('active');
    const script = h.script(h.window(h.store.sessions.require(id).tmuxTarget));
    expect(script).toContain('your terminal closed');
    expect(script).toContain('do not trust a partial log');
    expect(script).toContain('Rerun what you were waiting on');
    expect(tries(id).map((e) => e.text)).toEqual([
      'Auto-resume: try 1 of 3: relaunched the agent 1 min after it was found gone.',
    ]);
  });

  it('waits 1, 5 and 15 minutes, then alerts once and stops until a person sends a message', async () => {
    const { h, clock, ids, onAlert, monitor, kill, status, tries } = await setup();
    const [id] = ids as [number];
    const m = monitor();
    for (const wait of [1, 5, 15]) {
      kill(id);
      await m.checkOnce();
      clock.advance(wait * MINUTE - 1_000);
      await m.checkOnce();
      expect(status(id)).toBe('paused:agent_exited');
      clock.advance(1_000);
      await m.checkOnce();
      expect(status(id)).toBe('active');
    }
    expect(tries(id)).toHaveLength(3);
    kill(id);
    await m.checkOnce();
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0]?.[1]).toContain('resumed automatically 3 times in 24 hours');
    // A day later the window has rolled, but it stays stopped: a person has to act.
    for (let i = 0; i < 4; i++) {
      clock.advance(8 * 60 * MINUTE);
      await m.checkOnce();
    }
    expect(status(id)).toBe('paused:agent_exited');
    expect(onAlert).toHaveBeenCalledTimes(1);
    h.store.requests.create({ projectId: h.shop.id, sessionId: id, text: 'carry on', source: 'dashboard' });
    await m.checkOnce();
    clock.advance(MINUTE);
    await m.checkOnce();
    expect(status(id)).toBe('active');
  });

  it('counts a failed resume, and keeps its counts across a server restart', async () => {
    const { h, clock, ids, onAlert, monitor, kill, status, tries } = await setup();
    const [id] = ids as [number];
    kill(id);
    const first = monitor();
    await first.checkOnce();
    const newWindow = h.tmux.newWindow.bind(h.tmux);
    h.tmux.newWindow = () => Promise.reject(new Error('tmux broke'));
    clock.advance(MINUTE);
    await first.checkOnce();
    expect(status(id)).toBe('paused:agent_exited');
    expect(tries(id).map((e) => e.text)).toEqual(['Auto-resume: try 1 of 3 failed: tmux broke']);
    h.tmux.newWindow = newWindow;
    clock.advance(5 * MINUTE);
    await first.checkOnce();
    expect(status(id)).toBe('active');

    // A new server process: a new runner and monitor, the same database.
    const runner = new SessionRunner(
      {
        store: h.store,
        fs: h.fs,
        git: h.git,
        tmux: h.tmux,
        agentCli: new DefaultAgentCli(),
        log: () => undefined,
      },
      {
        worktreesRoot: '/wt',
        serverUrl: 'http://srv:8787/',
        claudeProjectsDir: '/claude/projects',
        env: { MCP_TOKEN: 't' },
      },
    );
    const second = monitor(runner);
    kill(id);
    await second.checkOnce();
    clock.advance(14 * MINUTE);
    await second.checkOnce();
    expect(status(id)).toBe('paused:agent_exited'); // its third try waits 15 minutes, not 1
    clock.advance(MINUTE);
    await second.checkOnce();
    expect(status(id)).toBe('active');
    kill(id);
    await second.checkOnce();
    clock.advance(60 * MINUTE);
    await second.checkOnce();
    expect(status(id)).toBe('paused:agent_exited');
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(tries(id)).toHaveLength(3);
  });

  it('never resumes a manual or usage-limit pause, an ended session, a taken-over one or a folder session', async () => {
    const { h, clock, ids, launches, monitor, kill, status } = await setup(4);
    const [manual, limit, ended, takenOver] = ids as [number, number, number, number];
    await h.runner.pause(manual, 'manual');
    await h.runner.pause(limit, 'usage_limit');
    await h.runner.end(ended);
    const pr = h.store.pullRequests.create({
      projectId: h.shop.id,
      repo: 'web',
      number: 1,
      url: 'u',
      sessionId: takenOver,
    });
    h.store.pullRequests.update(pr.id, { outcome: 'escalated' });
    kill(takenOver);
    // A folder session paused as agent_exited (reconcile ends them; this one got here another way).
    h.fs.dirs.add('/home/me/notes');
    const notes = h.store.projects.create({ name: 'Notes', kind: 'folder', folderPath: '/home/me/notes' });
    const folder = await h.runner.startSession(notes.id, { text: 'tidy' });
    await h.runner.pause(folder.id, 'manual');
    h.store.sessions.update(folder.id, { status: 'paused', pauseReason: 'agent_exited' });
    launches.mockClear();
    const m = monitor();
    for (let i = 0; i < 10; i++) {
      await m.checkOnce();
      clock.advance(30 * MINUTE);
    }
    expect(launches).not.toHaveBeenCalled();
    expect([manual, limit, ended, takenOver, folder.id].map(status)).toEqual([
      'paused:manual',
      'paused:usage_limit',
      'ended',
      'paused:agent_exited',
      'paused:agent_exited',
    ]);
    expect(h.store.history.list({}).filter((e) => e.text.startsWith('Auto-resume'))).toEqual([]);
  });

  it('leaves a session with a PR in the loop to the loop, and never launches twice in a race', async () => {
    const { h, clock, ids, launches, monitor, kill, status, tries } = await setup(2);
    const [withPr, plain] = ids as [number, number];
    h.store.pullRequests.create({
      projectId: h.shop.id,
      repo: 'web',
      number: 2,
      url: 'u',
      sessionId: withPr,
    });
    kill(withPr);
    kill(plain);
    const m = monitor();
    await m.checkOnce();
    launches.mockClear();
    clock.advance(60 * MINUTE);
    // The loop's resumeBuilder (runner.resume with ifReason) and this pass, at the same moment.
    await Promise.all([
      m.checkOnce(),
      h.runner.resume(plain, { ifReason: 'agent_exited', reason: 'feedback' }),
    ]);
    expect(status(plain)).toBe('active');
    expect(launches).toHaveBeenCalledTimes(1);
    expect(status(withPr)).toBe('paused:agent_exited');
    expect(tries(withPr)).toEqual([]);
    // The other order: the loop resumes once it has feedback, and a stale decision launches nothing.
    await h.runner.resume(withPr, { ifReason: 'agent_exited', reason: 'feedback' });
    expect(await h.runner.resumePaused(withPr, 'agent_exited')).toBeNull();
    expect(launches).toHaveBeenCalledTimes(2);
  });
});

describe('several agents going at once', () => {
  it('alerts once naming them all, and still resumes each', async () => {
    const { clock, ids, onAlert, monitor, kill, status } = await setup(3);
    const m = monitor();
    for (const id of ids) kill(id);
    await m.checkOnce();
    await m.checkOnce();
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0]?.[1]).toContain(
      `Sessions ${ids[0]}, ${ids[1]} and ${ids[2]} lost their agents at once.`,
    );
    clock.advance(MINUTE);
    await m.checkOnce();
    expect(ids.map(status)).toEqual(['active', 'active', 'active']);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it('does not alert for a single agent that exits while the tmux server stays up', async () => {
    const { ids, onAlert, monitor, kill } = await setup(2);
    const m = monitor();
    await m.checkOnce();
    kill(ids[0]!);
    await m.checkOnce();
    expect(onAlert).not.toHaveBeenCalled();
  });
});

describe("the tmux server's death", () => {
  it('is recorded once, with its pid, how long it ran and when it was last seen', async () => {
    const { h, clock, ids, onAlert, monitor, kill } = await setup();
    const [id] = ids as [number];
    const m = monitor();
    await m.checkOnce(); // 09:00, the server started at 08:00
    clock.advance(10 * MINUTE);
    await m.checkOnce();
    clock.advance(MINUTE);
    h.tmux.serverInfo = { pid: 777, startedAt: clock.now().getTime() };
    kill(id);
    await m.checkOnce();
    const recorded = h.store.history.list({}).filter((e) => e.text.startsWith('The tmux server'));
    expect(recorded.map((e) => [e.projectId, e.sessionId])).toEqual([[h.shop.id, null]]);
    expect(recorded[0]?.text).toBe(
      'The tmux server (pid 4242, started 2026-10-18T08:00:00.000Z) is gone, replaced by pid 777. It ran for ' +
        `1 h 10 min and was last seen alive at 2026-10-18T09:10:00.000Z; found gone at 2026-10-18T09:11:00.000Z, with sessions ${id}.`,
    );
    expect(h.logs.some((l) => l.includes('The tmux server (pid 4242'))).toBe(true);
    // One agent, but the server went with it: the owner hears, once.
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0]?.[1]).toContain('(pid 4242) died: it ran for 1 h 10 min');
    await m.checkOnce();
    clock.advance(MINUTE);
    await m.checkOnce();
    expect(h.store.history.list({}).filter((e) => e.text.startsWith('The tmux server'))).toHaveLength(1);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it('is remembered across a server restart, and a server that just exited empty is not a death', async () => {
    const { h, clock, ids, monitor, kill } = await setup();
    const [id] = ids as [number];
    await monitor().checkOnce();
    // The server exits after its last window closed normally: nothing to record.
    await h.runner.pause(id, 'manual');
    h.tmux.serverInfo = null;
    await monitor().checkOnce();
    expect(h.store.history.list({}).filter((e) => e.text.startsWith('The tmux server'))).toEqual([]);
    // A new server for the resumed session; then Loop restarts, and the server dies while it was down.
    h.tmux.serverInfo = { pid: 5000, startedAt: clock.now().getTime() };
    await h.runner.resume(id);
    await monitor().checkOnce();
    clock.advance(30 * MINUTE);
    const runner = new SessionRunner(
      {
        store: h.store,
        fs: h.fs,
        git: h.git,
        tmux: h.tmux,
        agentCli: new DefaultAgentCli(),
        log: () => undefined,
      },
      {
        worktreesRoot: '/wt',
        serverUrl: 'http://srv:8787/',
        claudeProjectsDir: '/claude/projects',
        env: { MCP_TOKEN: 't' },
      },
    );
    h.tmux.serverInfo = null;
    kill(id);
    await monitor(runner).checkOnce();
    const [entry] = h.store.history.list({}).filter((e) => e.text.startsWith('The tmux server'));
    expect(entry?.text).toContain(
      'The tmux server (pid 5000, started 2026-10-18T09:00:00.000Z) is gone. It ran for 0 min',
    );
  });
});
