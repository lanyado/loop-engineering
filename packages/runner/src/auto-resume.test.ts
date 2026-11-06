import type { FakeClock } from '@loop-engineering/core';
import { describe, expect, it, vi } from 'vitest';
import { DefaultAgentCli } from './agent-cli.js';
import { UsageLimitMonitor, type MonitorOptions } from './monitor.js';
import { SessionRunner } from './runner.js';
import { harness, type Harness } from './test-support/harness.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A new server process: a new runner on the same database, files and tmux. */
const restartedRunner = (h: Harness) =>
  new SessionRunner(
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
  const target = (id: number) => h.store.sessions.require(id).tmuxTarget ?? '';
  /** The agent's window vanishes: closed from outside, or gone with the tmux server. */
  const vanish = (id: number) => h.tmux.windows.delete(target(id));
  /** The agent exits by itself: its window stays with a dead pane (remain-on-exit). */
  const exit = (id: number) => {
    h.window(target(id)).dead = true;
  };
  const status = (id: number) => {
    const s = h.store.sessions.require(id);
    return s.status === 'paused' ? `paused:${s.pauseReason}` : s.status;
  };
  const tries = (id: number) =>
    h.store.history.list({ sessionId: id }).filter((e) => e.text.startsWith('Auto-resume:'));
  const deaths = () => h.store.history.list({}).filter((e) => e.text.startsWith('The tmux server'));
  return { h, clock, ids, onAlert, launches, monitor, vanish, exit, status, tries, deaths };
}

describe('auto-resume of an agent that went away', () => {
  it('resumes after a minute, telling the agent what happened', async () => {
    const { h, clock, ids, monitor, vanish, status, tries } = await setup();
    const [id] = ids as [number];
    const m = monitor();
    vanish(id);
    await m.checkOnce();
    expect(status(id)).toBe('paused:agent_exited');
    clock.advance(59_000);
    await m.checkOnce();
    expect(status(id)).toBe('paused:agent_exited');
    clock.advance(2_000);
    await m.checkOnce();
    expect(status(id)).toBe('active');
    const script = h.script(h.window(h.store.sessions.require(id).tmuxTarget));
    expect(script).toContain('your agent process exited or its terminal closed');
    expect(script).toContain('may have died or may still be running');
    expect(script).toContain('never start a second copy');
    expect(tries(id).map((e) => e.text)).toEqual([
      'Auto-resume: try 1 of 3: relaunched the agent 1 min after it was found gone.',
    ]);
  });

  it('also resumes an agent that exited by itself, whose dead pane says so', async () => {
    const { h, clock, ids, monitor, exit, status } = await setup();
    const [id] = ids as [number];
    const m = monitor();
    exit(id);
    await m.checkOnce();
    const [gone] = h.store.history.list({ sessionId: id }).filter((e) => e.text.startsWith('Agent gone:'));
    expect(gone?.text).toContain('its process exited in tmux window');
    clock.advance(MINUTE);
    await m.checkOnce();
    expect(status(id)).toBe('active');
  });

  it('waits 1, 5 and 15 minutes, then alerts once and stops until a person sends a message', async () => {
    const { h, clock, ids, onAlert, monitor, vanish, status, tries } = await setup();
    const [id] = ids as [number];
    const m = monitor();
    for (const wait of [1, 5, 15]) {
      vanish(id);
      await m.checkOnce();
      clock.advance(wait * MINUTE - 1_000);
      await m.checkOnce();
      expect(status(id)).toBe('paused:agent_exited');
      clock.advance(1_000);
      await m.checkOnce();
      expect(status(id)).toBe('active');
    }
    expect(tries(id)).toHaveLength(3);
    vanish(id);
    await m.checkOnce();
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0]?.[1]).toContain('resumed automatically 3 times in 24 hours');
    // The loop's own requests are not a person acting.
    h.store.requests.create({
      projectId: h.shop.id,
      sessionId: id,
      text: '[loop] Fix it',
      source: 'dashboard',
    });
    for (let i = 0; i < 6; i++) {
      await m.checkOnce();
      clock.advance(30 * MINUTE);
    }
    expect(status(id)).toBe('paused:agent_exited');
    expect(onAlert).toHaveBeenCalledTimes(1);
    // A person's message resumes it (the router does that) and starts the count again.
    h.store.requests.create({ projectId: h.shop.id, sessionId: id, text: 'carry on', source: 'dashboard' });
    await h.runner.resume(id, { reason: 'a message' });
    vanish(id);
    await m.checkOnce();
    clock.advance(MINUTE);
    await m.checkOnce();
    expect(status(id)).toBe('active');
  });

  it('counts a failed resume, and keeps its counts across a server restart', async () => {
    const { h, clock, ids, onAlert, monitor, vanish, status, tries } = await setup();
    const [id] = ids as [number];
    vanish(id);
    const first = monitor();
    await first.checkOnce();
    const newWindow = h.tmux.newWindow.bind(h.tmux);
    h.tmux.newWindow = () => Promise.reject(new Error('tmux broke'));
    clock.advance(MINUTE);
    await first.checkOnce();
    expect(status(id)).toBe('paused:agent_exited');
    expect(tries(id).map((e) => e.text)).toEqual(['Auto-resume: try 1 of 3 failed: tmux broke']);
    // The owner hears of a failed try at once, not only when the tries run out.
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0]?.[1]).toContain(
      'automatic resume try 1 of 3 failed: tmux broke. It is tried again in 5 min',
    );
    h.tmux.newWindow = newWindow;
    clock.advance(5 * MINUTE);
    await first.checkOnce();
    expect(status(id)).toBe('active');

    const second = monitor(restartedRunner(h));
    vanish(id);
    await second.checkOnce();
    clock.advance(14 * MINUTE);
    await second.checkOnce();
    expect(status(id)).toBe('paused:agent_exited'); // its third try waits 15 minutes, not 1
    clock.advance(MINUTE);
    await second.checkOnce();
    expect(status(id)).toBe('active');
    vanish(id);
    await second.checkOnce();
    clock.advance(60 * MINUTE);
    await second.checkOnce();
    expect(status(id)).toBe('paused:agent_exited');
    expect(onAlert).toHaveBeenCalledTimes(2);
    expect(onAlert.mock.calls[1]?.[1]).toContain('resumed automatically 3 times in 24 hours');
    expect(tries(id)).toHaveLength(3);
  });

  it('stops at a last try that fails, with one alert saying why', async () => {
    const { h, clock, ids, onAlert, monitor, vanish, status, tries } = await setup();
    const [id] = ids as [number];
    const m = monitor();
    vanish(id);
    await m.checkOnce();
    h.tmux.newWindow = () => Promise.reject(new Error('no space left'));
    for (let i = 0; i < 8; i++) {
      clock.advance(5 * MINUTE);
      await m.checkOnce();
    }
    expect(status(id)).toBe('paused:agent_exited');
    expect(tries(id)).toHaveLength(3);
    expect(onAlert).toHaveBeenCalledTimes(3); // tries 1 and 2, then the stop
    expect(onAlert.mock.calls[2]?.[1]).toContain(
      'lost its agent, and the last of 3 automatic resumes in 24 hours failed: no space left. It stays paused',
    );
    const stopped = h.store.history
      .list({ sessionId: id })
      .filter((e) => e.text.startsWith('Auto-resume stopped'));
    expect(stopped.map((e) => e.text)).toEqual([
      'Auto-resume stopped: the last of 3 automatic resumes in 24 hours failed (no space left). It stays paused until a person sends it a message.',
    ]);
  });

  it('never resumes a manual or usage-limit pause, an ended session, a taken-over one or a folder session', async () => {
    const { h, clock, ids, launches, monitor, vanish, status } = await setup(4);
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
    vanish(takenOver);
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

  it('never wakes a session the loop stopped, or one whose PR is done', async () => {
    const { h, clock, ids, launches, monitor, vanish, status } = await setup(2);
    const [closed, merged] = ids as [number, number];
    const prs = ids.map((sessionId, i) =>
      h.store.pullRequests.create({ projectId: h.shop.id, repo: 'web', number: i + 1, url: 'u', sessionId }),
    );
    for (const id of ids) vanish(id);
    const m = monitor();
    await m.checkOnce(); // the loop owns both: they have PRs in the loop
    // The owner closes one PR: the loop pauses its session, and that stop now wins over agent_exited.
    h.store.pullRequests.update(prs[0]!.id, { outcome: 'closed' });
    await h.runner.pause(closed, 'manual');
    // The other merged; cleanup has not ended its session yet.
    h.store.pullRequests.update(prs[1]!.id, { outcome: 'merged' });
    launches.mockClear();
    for (let i = 0; i < 4; i++) {
      clock.advance(15 * MINUTE);
      await m.checkOnce();
    }
    expect(launches).not.toHaveBeenCalled();
    expect([closed, merged].map(status)).toEqual(['paused:manual', 'paused:agent_exited']);
    // A person's later message makes it theirs again: its next exit is resumed.
    h.store.requests.create({
      projectId: h.shop.id,
      sessionId: merged,
      text: 'one more thing',
      source: 'dashboard',
    });
    await h.runner.resume(merged, { reason: 'a message' });
    vanish(merged);
    await m.checkOnce();
    clock.advance(MINUTE);
    await m.checkOnce();
    expect(status(merged)).toBe('active');
  });

  it('never wakes a session found gone long ago, or one paused before it ran', async () => {
    const { h, clock, ids, launches, monitor, vanish, status } = await setup(2);
    const [old, unknown] = ids as [number, number];
    vanish(old);
    await h.runner.reconcile(); // a Loop without auto-resume found it gone
    clock.advance(4 * HOUR);
    await h.runner.pause(unknown, 'manual');
    h.store.sessions.update(unknown, { status: 'paused', pauseReason: 'agent_exited' });
    launches.mockClear();
    const m = monitor(); // the deploy
    for (let i = 0; i < 4; i++) {
      await m.checkOnce();
      clock.advance(15 * MINUTE);
    }
    expect(launches).not.toHaveBeenCalled();
    expect([old, unknown].map(status)).toEqual(['paused:agent_exited', 'paused:agent_exited']);
  });

  it('waits while the conversation still grows, as when tmux was only unreachable', async () => {
    const { h, clock, ids, monitor, vanish, status } = await setup();
    const [id] = ids as [number];
    const file = `/claude/projects/-wt-shop-x/${String(h.store.sessions.require(id).agentSessionId)}.jsonl`;
    await h.fs.writeFile(file, '{}\n');
    const m = monitor();
    vanish(id);
    await m.checkOnce();
    await h.fs.writeFile(file, '{}\n{"more":1}\n');
    clock.advance(MINUTE);
    await m.checkOnce();
    expect(status(id)).toBe('paused:agent_exited');
    expect(h.logs.some((l) => l.includes('its conversation is still growing'))).toBe(true);
    clock.advance(MINUTE);
    await m.checkOnce();
    expect(status(id)).toBe('active');
  });

  it('leaves a session with a PR in the loop to the loop, and never launches twice in a race', async () => {
    const { h, clock, ids, launches, monitor, vanish, status, tries } = await setup(2);
    const [withPr, plain] = ids as [number, number];
    h.store.pullRequests.create({
      projectId: h.shop.id,
      repo: 'web',
      number: 2,
      url: 'u',
      sessionId: withPr,
    });
    vanish(withPr);
    vanish(plain);
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
    const { clock, ids, onAlert, monitor, vanish, status } = await setup(3);
    const m = monitor();
    await m.checkOnce();
    for (const id of ids) vanish(id);
    await m.checkOnce();
    await m.checkOnce();
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0]?.[1]).toBe(
      `Sessions ${ids[0]}, ${ids[1]} and ${ids[2]} lost their agents at once. They are resumed automatically, ` +
        'at most 3 times in 24 hours. You hear again only if resuming stops working.',
    );
    clock.advance(MINUTE);
    await m.checkOnce();
    expect(ids.map(status)).toEqual(['active', 'active', 'active']);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it('says which sessions it resumes, leaves to the loop or paused, and which it ended', async () => {
    const { h, ids, onAlert, monitor, vanish } = await setup(4);
    const [plain, inLoop, takenOver, done] = ids as [number, number, number, number];
    const pr = (sessionId: number, number: number) =>
      h.store.pullRequests.create({ projectId: h.shop.id, repo: 'web', number, url: 'u', sessionId });
    pr(inLoop, 1);
    h.store.pullRequests.update(pr(takenOver, 2).id, { outcome: 'escalated' });
    h.store.pullRequests.update(pr(done, 3).id, { outcome: 'closed' });
    h.fs.dirs.add('/home/me/notes');
    const notes = h.store.projects.create({ name: 'Notes', kind: 'folder', folderPath: '/home/me/notes' });
    const folder = (await h.runner.startSession(notes.id, { text: 'tidy' })).id;
    const m = monitor();
    await m.checkOnce();
    for (const id of [...ids, folder]) vanish(id);
    await m.checkOnce();
    expect(h.store.sessions.require(folder).status).toBe('ended');
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0]?.[0]).not.toMatchObject({ status: 'ended' });
    expect(onAlert.mock.calls[0]?.[1]).toBe(
      `Sessions ${plain}, ${inLoop}, ${takenOver}, ${done} and ${folder} lost their agents at once. ` +
        `Session ${plain} is resumed automatically, at most 3 times in 24 hours. ` +
        `Session ${inLoop} has a PR in the loop, which resumes it when the PR needs it. ` +
        `Sessions ${takenOver} and ${done} stay paused: their PRs were sent to you or taken over, or finished since ` +
        `your last message. Session ${folder} was ended: a folder session is not resumed. ` +
        'You hear again only if resuming stops working.',
    );
  });

  it('lists a session out of resumes as stopping, and promises nothing when none is resumed', async () => {
    const { h, ids, onAlert, monitor, vanish } = await setup(2);
    const [spent, takenOver] = ids as [number, number];
    for (let i = 1; i <= 3; i++)
      h.store.history.add({
        projectId: h.shop.id,
        sessionId: spent,
        kind: 'decision',
        text: `Auto-resume: try ${i} of 3: relaunched the agent 1 min after it was found gone.`,
      });
    const pr = h.store.pullRequests.create({
      projectId: h.shop.id,
      repo: 'web',
      number: 1,
      url: 'u',
      sessionId: takenOver,
    });
    h.store.pullRequests.update(pr.id, { outcome: 'escalated' });
    const m = monitor();
    await m.checkOnce();
    for (const id of ids) vanish(id);
    await m.checkOnce();
    expect(onAlert.mock.calls[0]?.[1]).toBe(
      `Sessions ${spent} and ${takenOver} lost their agents at once. Session ${spent} has used its 3 automatic ` +
        `resumes in 24 hours and stays paused until you send it a message. Session ${takenOver} stays paused: its PR ` +
        'was sent to you or taken over, or finished since your last message.',
    );
    // The same pass stops it, as the alert said.
    expect(onAlert).toHaveBeenCalledTimes(2);
    expect(onAlert.mock.calls[1]?.[1]).toContain(`Session ${spent} ("build 0") keeps losing its agent`);
  });

  it('tells of failed tries of sessions lost together in one alert per pass', async () => {
    const { h, clock, ids, onAlert, monitor, vanish, status } = await setup(3);
    const m = monitor();
    await m.checkOnce();
    for (const id of ids) vanish(id);
    await m.checkOnce();
    h.tmux.newWindow = () => Promise.reject(new Error('tmux broke'));
    for (let i = 0; i < 8; i++) {
      clock.advance(5 * MINUTE);
      await m.checkOnce();
    }
    expect(ids.map(status)).toEqual(['paused:agent_exited', 'paused:agent_exited', 'paused:agent_exited']);
    const texts = onAlert.mock.calls.map((c) => String(c[1]));
    expect(texts).toHaveLength(4); // lost at once, try 1, try 2, out of resumes
    const [a, b, c] = ids as [number, number, number];
    expect(texts[1]).toBe(
      `Sessions ${a}, ${b} and ${c} lost their agents, and an automatic resume of each failed. ` +
        `Session ${a} ("build 0"): try 1 of 3 failed: tmux broke; tried again in 5 min. ` +
        `Session ${b} ("build 1"): try 1 of 3 failed: tmux broke; tried again in 5 min. ` +
        `Session ${c} ("build 2"): try 1 of 3 failed: tmux broke; tried again in 5 min. ` +
        'You hear again about a session when its resumes run out, whether they fail or its agent keeps going away.',
    );
    expect(texts[3]).toContain(`Sessions ${a}, ${b} and ${c} stay paused, out of automatic resumes.`);
    expect(texts[3]).toContain(
      `Session ${c} ("build 2"): the last of 3 automatic resumes in 24 hours failed: tmux broke.`,
    );
  });

  it('cuts a long error short, so the alert still fits a question', async () => {
    const { h, clock, ids, onAlert, monitor, vanish, tries } = await setup();
    const [id] = ids as [number];
    const m = monitor();
    vanish(id);
    await m.checkOnce();
    const huge = `tmux new-window ${'x'.repeat(20_000)}`;
    h.tmux.newWindow = () => Promise.reject(new Error(huge));
    for (let i = 0; i < 8; i++) {
      clock.advance(5 * MINUTE);
      await m.checkOnce();
    }
    expect(onAlert).toHaveBeenCalledTimes(3);
    for (const [, text] of onAlert.mock.calls) expect(String(text).length).toBeLessThan(700);
    expect(onAlert.mock.calls[2]?.[1]).toMatch(/failed: tmux new-window x+…\. It stays paused/);
    // The history keeps the whole error.
    expect(tries(id)[0]?.text).toContain(huge);
  });

  it('does not alert for agents that exited by themselves, or for one window closing', async () => {
    const { ids, onAlert, monitor, vanish, exit } = await setup(3);
    const m = monitor();
    await m.checkOnce();
    exit(ids[0]!);
    exit(ids[1]!);
    await m.checkOnce();
    vanish(ids[2]!);
    await m.checkOnce();
    expect(onAlert).not.toHaveBeenCalled();
  });

  it('does not call exits found by the first pass after a start "at once"', async () => {
    const { ids, onAlert, monitor, vanish, deaths } = await setup(2);
    for (const id of ids) vanish(id);
    await monitor().checkOnce();
    expect(onAlert).not.toHaveBeenCalled();
    expect(deaths()).toEqual([]);
  });
});

describe("the tmux server's death", () => {
  it('is recorded once, with its pid, how long it ran and when it was last seen', async () => {
    const { h, clock, ids, onAlert, monitor, vanish, deaths } = await setup();
    const [id] = ids as [number];
    const m = monitor();
    await m.checkOnce(); // 09:00, the server started at 08:00
    clock.advance(10 * MINUTE);
    await m.checkOnce();
    clock.advance(MINUTE);
    h.tmux.serverInfo = { pid: 777, startedAt: clock.now().getTime() };
    vanish(id);
    await m.checkOnce();
    const recorded = deaths();
    expect(recorded.map((e) => [e.projectId, e.sessionId])).toEqual([[h.shop.id, null]]);
    expect(recorded[0]?.text).toBe(
      'The tmux server (pid 4242, started 2026-10-18T08:00:00.000Z) is gone, replaced by pid 777. It ran for ' +
        `1 h 10 min and was last seen alive at 2026-10-18T09:10:00.000Z; found gone at 2026-10-18T09:11:00.000Z, with sessions ${id}.`,
    );
    expect(h.logs.some((l) => l.includes('The tmux server (pid 4242'))).toBe(true);
    // One agent, but the server went with it: the owner hears, once.
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0]?.[1]).toBe(
      `Session ${id} lost its agent when the tmux server holding it (pid 4242) died: it ran for 1 h 10 min and ` +
        'was last seen alive at 2026-10-18T09:10:00.000Z. It is resumed automatically, at most 3 times in 24 hours. ' +
        'You hear again only if resuming stops working.',
    );
    await m.checkOnce();
    clock.advance(MINUTE);
    await m.checkOnce();
    expect(deaths()).toHaveLength(1);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it('is not the last agent exiting by itself, after which tmux exits empty', async () => {
    const { h, clock, ids, onAlert, monitor, exit, vanish, status, deaths } = await setup();
    const [id] = ids as [number];
    const m = monitor();
    await m.checkOnce();
    clock.advance(MINUTE);
    // Claude exits; reconcile closes its dead window, and tmux, with nothing left, exits too.
    exit(id);
    h.tmux.serverInfo = null;
    await m.checkOnce();
    expect(deaths()).toEqual([]);
    expect(onAlert).not.toHaveBeenCalled();
    // The resume starts a new server. When that one dies, it is the one reported, not the old one.
    h.tmux.serverInfo = { pid: 6000, startedAt: clock.now().getTime() };
    clock.advance(MINUTE);
    await m.checkOnce();
    expect(status(id)).toBe('active');
    clock.advance(MINUTE);
    await m.checkOnce();
    clock.advance(MINUTE);
    h.tmux.serverInfo = null;
    vanish(id);
    await m.checkOnce();
    expect(deaths().map((e) => e.text.startsWith('The tmux server (pid 6000,'))).toEqual([true]);
  });

  it('is remembered across a server restart, and a server that just exited empty is not a death', async () => {
    const { h, clock, ids, onAlert, monitor, vanish, deaths } = await setup();
    const [id] = ids as [number];
    await monitor().checkOnce();
    // The server exits after its last window closed normally: nothing to record.
    await h.runner.pause(id, 'manual');
    h.tmux.serverInfo = null;
    await monitor().checkOnce();
    expect(deaths()).toEqual([]);
    // A new server for the resumed session; then Loop restarts, and the server dies while it was down.
    h.tmux.serverInfo = { pid: 5000, startedAt: clock.now().getTime() };
    await h.runner.resume(id);
    await monitor().checkOnce();
    clock.advance(30 * MINUTE);
    h.tmux.serverInfo = null;
    vanish(id);
    await monitor(restartedRunner(h)).checkOnce();
    expect(deaths()[0]?.text).toContain(
      'The tmux server (pid 5000, started 2026-10-18T09:00:00.000Z) is gone. It ran for 0 min',
    );
    // Found by the first pass after the restart, the death still reaches the owner, once: another
    // restart before the session is resumed neither records nor alerts it again.
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0]?.[1]).toContain(
      `Session ${id} lost its agent when the tmux server holding it (pid 5000) died`,
    );
    await monitor(restartedRunner(h)).checkOnce();
    expect(deaths()).toHaveLength(1);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });
});
