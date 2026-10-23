import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageLimitMonitor } from './monitor.js';
import { harness } from './test-support/harness.js';
import { USAGE_LIMIT_PATTERNS } from './usage-limit.js';

/** Claude Code 2.1.302's trust dialog, as captured from a tmux pane. */
const TRUST_DIALOG = [
  '────────────────────────────────────────────────',
  ' Accessing workspace:',
  ' /wt/shop/stuck-sfx1/web',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a',
  ' well-known open source project, or work from your team). If not, take a moment to review what is',
  ' in this folder first.',
  " Claude Code'll be able to read, edit, and execute files here.",
  ' Security guide',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
  '',
].join('\n');

afterEach(() => {
  vi.useRealTimers();
});

describe('UsageLimitMonitor', () => {
  it('switches only the sessions whose pane ends with a usage-limit message', async () => {
    const h = harness();
    const a = await h.runner.startSession(h.shop.id, { text: 'a' });
    const b = await h.runner.startSession(h.shop.id, { text: 'b' });
    h.tmux.print(a.tmuxTarget ?? '', 'Working on it...\n\n  ⎿  5-hour limit reached ∙ resets 3pm\n> \n');
    h.tmux.print(
      b.tmuxTarget ?? '',
      "Still building\n  expect(line).toBe('5-hour limit reached ∙ resets 3pm');\n",
    );
    const onFallback = vi.fn();
    const monitor = new UsageLimitMonitor(h.runner, h.store, { onFallback });

    const pass = await monitor.checkOnce();
    expect(pass.switched.map((s) => s.id)).toEqual([a.id]);
    expect(pass.exited).toEqual([]);
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ id: a.id, provider: 'opencode' }));
    expect(h.store.sessions.require(b.id).provider).toBe('claude');
    expect(h.store.history.list({ sessionId: a.id })[0]?.text).toContain('5-hour limit reached ∙ resets 3pm');

    // A fresh OpenCode pane has nothing to act on: a second pass changes nothing.
    expect(await monitor.checkOnce()).toEqual({ switched: [], exited: [], trustWaits: [], rotated: [] });
  });

  it('with onClaudeLimit "wait", pauses a limited builder on Claude and resumes it there later', async () => {
    const h = harness({ onClaudeLimit: 'wait' });
    const a = await h.runner.startSession(h.shop.id, { text: 'a' });
    h.tmux.print(a.tmuxTarget ?? '', 'Working on it...\n\n  ⎿  5-hour limit reached ∙ resets 3pm\n> \n');
    let now = 0;
    const onLimitResumed = vi.fn();
    const monitor = new UsageLimitMonitor(h.runner, h.store, {
      now: () => now,
      retryClaudeLimitMs: 30 * 60_000,
      onLimitResumed,
    });

    await monitor.checkOnce();
    expect(h.store.sessions.require(a.id)).toMatchObject({
      status: 'paused',
      pauseReason: 'usage_limit',
      provider: 'claude',
    });
    expect(h.store.history.list({ sessionId: a.id })[0]?.text).toContain('Builders wait for Claude');

    now += 10 * 60_000;
    await monitor.checkOnce();
    expect(h.store.sessions.require(a.id).status).toBe('paused'); // too soon

    now += 25 * 60_000;
    await monitor.checkOnce();
    expect(h.store.sessions.require(a.id)).toMatchObject({ status: 'active', provider: 'claude' });
    expect(onLimitResumed).toHaveBeenCalledWith(expect.objectContaining({ id: a.id }));
  });

  it('never resumes a session the human paused', async () => {
    const h = harness({ onClaudeLimit: 'wait' });
    const a = await h.runner.startSession(h.shop.id, { text: 'a' });
    await h.runner.pause(a.id, 'manual');
    let now = 0;
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => now, retryClaudeLimitMs: 60_000 });
    await monitor.checkOnce();
    now += 10 * 60_000;
    await monitor.checkOnce();
    expect(h.store.sessions.require(a.id)).toMatchObject({ status: 'paused', pauseReason: 'manual' });
  });

  it('moves an OpenCode session to the next model on a model error, or when its busy agent hangs', async () => {
    const h = harness();
    h.store.settings.update({ claudeEnabled: false, opencodeBackupModels: ['opencode/b', 'opencode/c'] });
    const fallback = h.store.settings.get().fallbackModel;
    const a = await h.runner.startSession(h.shop.id, { text: 'a' });
    const b = await h.runner.startSession(h.shop.id, { text: 'b' });
    let now = 0;
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => now, stallMs: 30 * 60_000 });
    h.tmux.print(a.tmuxTarget ?? '', 'Working\n\nError: 429 Too Many Requests\n> \n');
    h.tmux.print(b.tmuxTarget ?? '', '⠋ Thinking\n⬝■■⬝ esc interrupt  52K (26%)\n');
    expect((await monitor.checkOnce()).rotated.map((s) => [s.id, s.model])).toEqual([[a.id, 'opencode/b']]);
    expect(h.store.sessions.require(a.id).status).toBe('active');
    // A continued OpenCode conversation keeps its old model: the move starts a fresh one.
    const script = h.script(h.window(h.store.sessions.require(a.id).tmuxTarget));
    expect(script).toContain("exec 'opencode' '--standalone' '--auto' '--prompt=");
    expect(script).not.toContain("'--continue'");
    expect(h.store.history.list({ sessionId: a.id })[0]?.text).toContain(`from ${fallback} to opencode/b`);

    // b only animates its spinner: still the same screen. Hung after 30 minutes.
    now = 29 * 60_000;
    h.tmux.print(b.tmuxTarget ?? '', '⠙ Thinking\n⬝⬝■■ esc interrupt  52K (26%)\n');
    expect((await monitor.checkOnce()).rotated).toEqual([]);
    now = 31 * 60_000;
    expect((await monitor.checkOnce()).rotated.map((s) => [s.id, s.model])).toEqual([[b.id, 'opencode/b']]);
    expect(h.store.history.list({ sessionId: b.id })[0]?.text).toContain('no progress for 31 minutes');
  });

  it('takes an extended pattern list', async () => {
    const h = harness();
    const s = await h.runner.startSession(h.shop.id, { text: 'a' });
    h.tmux.print(s.tmuxTarget ?? '', 'Quota exhausted for today\n');
    expect((await new UsageLimitMonitor(h.runner, h.store).checkOnce()).switched).toEqual([]);
    const monitor = new UsageLimitMonitor(h.runner, h.store, {
      patterns: [...USAGE_LIMIT_PATTERNS, /^Quota exhausted/i],
    });
    expect((await monitor.checkOnce()).switched).toHaveLength(1);
  });

  it('pauses sessions whose agent is gone, and keeps checking the others when one fails', async () => {
    const h = harness();
    const gone = await h.runner.startSession(h.shop.id, { text: 'gone' });
    const failing = await h.runner.startSession(h.shop.id, { text: 'failing' });
    const limited = await h.runner.startSession(h.shop.id, { text: 'limited' });
    h.tmux.windows.delete(gone.tmuxTarget ?? '');
    h.tmux.print(limited.tmuxTarget ?? '', "You've hit your limit · resets 5pm (Europe/Berlin)\n");
    const capture = h.tmux.capture.bind(h.tmux);
    vi.spyOn(h.tmux, 'capture').mockImplementation((target: string) =>
      target === failing.tmuxTarget ? Promise.reject(new Error('capture failed')) : capture(target),
    );
    const onError = vi.fn();
    const onAgentExited = vi.fn();
    const pass = await new UsageLimitMonitor(h.runner, h.store, { onError, onAgentExited }).checkOnce();
    expect(pass.exited.map((s) => s.id)).toEqual([gone.id]);
    expect(onAgentExited).toHaveBeenCalledWith(
      expect.objectContaining({ id: gone.id, pauseReason: 'agent_exited' }),
    );
    expect(pass.switched.map((s) => s.id)).toEqual([limited.id]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'capture failed' }), failing.id);
  });

  it('does not act on a pane read from a window that was replaced in the meantime', async () => {
    const h = harness();
    const s = await h.runner.startSession(h.shop.id, { text: 'a' });
    h.tmux.print(s.tmuxTarget ?? '', 'Claude AI usage limit reached|1\n');
    // A pause queued before the check: by the time the check holds the lock the session is paused.
    const paused = h.runner.pause(s.id, 'manual');
    expect(await h.runner.checkUsageLimit(s.id)).toBeNull();
    await paused;
    expect(h.store.sessions.require(s.id)).toMatchObject({ provider: 'claude', pauseReason: 'manual' });
  });

  it('reports a session stuck at the folder-trust dialog once per launch, and never answers it', async () => {
    const h = harness();
    const stuck = await h.runner.startSession(h.shop.id, { text: 'stuck' });
    const fine = await h.runner.startSession(h.shop.id, { text: 'fine' });
    h.tmux.print(stuck.tmuxTarget ?? '', TRUST_DIALOG);
    h.tmux.print(fine.tmuxTarget ?? '', 'Editing README.md\n> \n');
    const onTrustPrompt = vi.fn();
    const monitor = new UsageLimitMonitor(h.runner, h.store, { onTrustPrompt });

    const pass = await monitor.checkOnce();
    expect(pass.trustWaits.map((s) => s.id)).toEqual([stuck.id]);
    expect(onTrustPrompt).toHaveBeenCalledTimes(1);
    expect(onTrustPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ id: stuck.id }),
      '/wt/shop/stuck-sfx1/web',
    );
    // The next pass sees the same dialog in the same window: no second report, no keys typed.
    expect((await monitor.checkOnce()).trustWaits).toEqual([]);
    expect(onTrustPrompt).toHaveBeenCalledTimes(1);
    expect(h.window(stuck.tmuxTarget).keys).toBe('');
    expect(h.store.sessions.require(stuck.id)).toMatchObject({ status: 'active', provider: 'claude' });

    // A relaunch (new window) stuck again is reported again.
    await h.runner.pause(stuck.id, 'manual');
    const again = await h.runner.resume(stuck.id);
    h.tmux.print(again.tmuxTarget ?? '', TRUST_DIALOG);
    expect((await monitor.checkOnce()).trustWaits.map((s) => s.id)).toEqual([stuck.id]);
    expect(onTrustPrompt).toHaveBeenCalledTimes(2);
  });

  it('runs a pass on start, then on an interval until stopped', async () => {
    vi.useFakeTimers();
    const h = harness();
    const monitor = new UsageLimitMonitor(h.runner, h.store, { intervalMs: 1000 });
    const spy = vi.spyOn(monitor, 'checkOnce');
    monitor.start();
    monitor.start(); // idempotent
    await vi.advanceTimersByTimeAsync(3500);
    expect(spy).toHaveBeenCalledTimes(4);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(spy).toHaveBeenCalledTimes(4);
  });
});
