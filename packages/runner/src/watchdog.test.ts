import { describe, expect, it, vi } from 'vitest';
import { IDLE_CLAUDE_PANE } from './fakes.js';
import { UsageLimitMonitor } from './monitor.js';
import { harness, type Harness } from './test-support/harness.js';
import { agentBusy, detectPermissionPrompt, runningShell } from './watchdog.js';

const MINUTE = 60_000;

/** As a tmux pane showed it, a pane title under the menu included. */
const PROMPT = [
  ' Read file',
  ' /wt/shop/x/web/node_modules resolves through a symlink to /src/web/node_modules, which is outside the allowed working directories',
  '',
  ' Do you want to proceed?',
  '   1. Yes',
  ' ❯ 2. Yes, and always allow access to /src/web/node_modules from this project',
  '   3. No',
  '',
  ' Esc to cancel',
  '                  A follow up by email',
].join('\n');

describe('reading the pane', () => {
  it('finds the permission menu, not the same words in a summary', () => {
    expect(detectPermissionPrompt(PROMPT)).toContain('resolves through a symlink');
    expect(detectPermissionPrompt(PROMPT)).toContain('Do you want to proceed?');
    expect(detectPermissionPrompt('The dialog said: Do you want to proceed?\n❯ \n')).toBeNull();
    expect(detectPermissionPrompt(IDLE_CLAUDE_PANE)).toBeNull();
  });

  it('tells a working agent from a finished one, and a running shell from a past one', () => {
    expect(agentBusy('✢ Bunning… (24m 36s · ↓ 66.8k tokens)\n❯ ')).toBe(true);
    expect(agentBusy('✻ Cooked for 15s · done 12:48 PM\n❯ ')).toBe(false);
    expect(runningShell('✻ Worked for 2m · done 4:40 PM · 1 shell still running\n❯ ')).toBe(true);
    expect(runningShell('⏵⏵ auto mode on · 1 shell')).toBe(true);
    expect(runningShell('Ran 8 shell commands\n❯ ')).toBe(false);
  });
});

async function setup(): Promise<{
  h: Harness;
  id: number;
  target: string;
  path: string;
  clock: { now: number };
}> {
  const h = harness();
  const s = await h.runner.startSession(h.shop.id, { text: 'build it' });
  const clock = { now: 1_000_000 };
  return { h, id: s.id, target: s.tmuxTarget ?? '', path: s.worktrees[0]?.path ?? '', clock };
}

describe('a permission question', () => {
  it('is refused after two minutes and never approved, and the agent hears why', async () => {
    const { h, id, target, clock } = await setup();
    const press = h.tmux.pressEscape.bind(h.tmux);
    h.tmux.pressEscape = async (t) => {
      await press(t);
      h.tmux.print(t, IDLE_CLAUDE_PANE); // Esc closes the dialog
    };
    h.tmux.print(target, PROMPT);
    const onError = vi.fn();
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now, onError });
    const keys = () => h.window(target).keys;

    await monitor.checkOnce();
    clock.now += 2 * MINUTE - 1;
    await monitor.checkOnce();
    expect(keys()).toBe('');

    clock.now += 1;
    await monitor.checkOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(keys().startsWith('<Esc>Automatic check: a permission question')).toBe(true);
    expect(keys()).not.toMatch(/^[123]|\n[123]/);
    const entry = h.store.history
      .list({ sessionId: id })
      .find((e) => e.text.startsWith('Permission watchdog'));
    expect(entry?.text).toContain('resolves through a symlink');
  });

  it('that goes away by itself is left alone', async () => {
    const { h, target, clock } = await setup();
    h.tmux.print(target, PROMPT);
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
    await monitor.checkOnce();
    h.tmux.print(target, IDLE_CLAUDE_PANE);
    clock.now += MINUTE;
    await monitor.checkOnce();
    h.tmux.print(target, PROMPT); // another one starts its own two minutes
    clock.now += MINUTE;
    await monitor.checkOnce();
    clock.now += MINUTE;
    await monitor.checkOnce();
    expect(h.window(target).keys).toBe('');
  });
});

describe('an idle agent with undelivered work', () => {
  const nudges = (h: Harness, id: number) =>
    h.store.history.list({ sessionId: id }).filter((e) => e.text.startsWith('Idle watchdog nudge')).length;

  it('gets three reminders with growing gaps and then one alert, across a restart', async () => {
    const { h, id, path, clock } = await setup();
    h.git.statuses.set(path, ' M src/a.ts');
    const onIdleAlert = vi.fn();
    const options = { now: () => clock.now, onIdleAlert };
    let monitor = new UsageLimitMonitor(h.runner, h.store, options);
    await monitor.checkOnce(); // the clock starts
    clock.now += 30 * MINUTE - 1;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(0);
    clock.now += 1;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(1);

    // A restart starts the idle clock again and keeps the count: it can only make reminders later.
    monitor = new UsageLimitMonitor(h.runner, h.store, options);
    await monitor.checkOnce();
    clock.now += 119 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(1);
    clock.now += MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(2);
    clock.now += 240 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(3);
    expect(onIdleAlert).not.toHaveBeenCalled();
    clock.now += 6 * MINUTE;
    await monitor.checkOnce();
    expect(onIdleAlert).toHaveBeenCalledTimes(1);
    clock.now += 600 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(3);
    expect(onIdleAlert).toHaveBeenCalledTimes(1);
  });

  it('counts commits its default branch lacks, not a linked node_modules', async () => {
    const { h, id, path, clock } = await setup();
    h.git.statuses.set(path, '?? node_modules');
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
    await monitor.checkOnce();
    clock.now += 31 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(0);
    h.git.ahead.set(path, 2);
    clock.now += 6 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(1);
  });

  it.each([
    ['nothing is undelivered', () => undefined, false],
    [
      'a question waits for an answer',
      (h: Harness, id: number) =>
        h.store.questions.create({ sessionId: id, text: 'q', options: ['a'], recommendedOption: 'a' }),
      true,
    ],
    [
      'its PR is in the loop',
      (h: Harness, id: number) =>
        h.store.pullRequests.create({
          projectId: h.shop.id,
          repo: 'web',
          number: 1,
          url: 'u',
          sessionId: id,
        }),
      true,
    ],
    [
      'its PR was taken over',
      (h: Harness, id: number) => {
        const pr = h.store.pullRequests.create({
          projectId: h.shop.id,
          repo: 'web',
          number: 1,
          url: 'u',
          sessionId: id,
        });
        h.store.pullRequests.update(pr.id, { outcome: 'escalated' });
      },
      true,
    ],
  ])('is left alone when %s', async (_name, arrange, dirty) => {
    const { h, id, path, clock } = await setup();
    if (dirty) h.git.statuses.set(path, ' M src/a.ts');
    arrange(h, id);
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
    await monitor.checkOnce();
    clock.now += 31 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(0);
    expect(h.window(h.store.sessions.require(id).tmuxTarget).keys).toBe('');
  });

  it('is not idle while it works, or before two hours with a background shell', async () => {
    const { h, id, path, target, clock } = await setup();
    h.git.statuses.set(path, ' M src/a.ts');
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
    h.tmux.print(target, `✢ Bunning… (24m 36s · ↓ 66.8k tokens)\n${IDLE_CLAUDE_PANE}`);
    await monitor.checkOnce();
    clock.now += 500 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(0);

    h.tmux.print(target, `${IDLE_CLAUDE_PANE} · 1 shell`);
    await monitor.checkOnce();
    clock.now += 119 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(0);
    clock.now += MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(1);
  });

  it('starts over when the conversation grows', async () => {
    const { h, id, path, clock } = await setup();
    h.git.statuses.set(path, ' M src/a.ts');
    const session = h.store.sessions.require(id);
    await h.saveConversation(session.agentSessionId);
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
    await monitor.checkOnce();
    clock.now += 29 * MINUTE;
    await monitor.checkOnce();
    await h.fs.writeFile(`/claude/projects/-wt-shop-x/${String(session.agentSessionId)}.jsonl`, '{}\n{}\n');
    clock.now += 2 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(0);
  });
});
