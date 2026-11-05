import type { FakeClock } from '@loop-engineering/core';
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

/** Claude Code 2.1.318 in auto mode, Read outside the folder, 120 wide: a real capture. */
const AUTO_DIALOG = [
  ' Read outside the working directories',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  ' Read(/etc/hostname)',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  ' Auto mode and the sandbox read outside the working directories without asking. Yes or No answers for this read; the ',
  ' rest is for later reads. Block: the file tools refuse reads outside the working directories in every project. The ',
  ' Allow this read outside the working directories?',
  ' ❯ 1. Yes, and keep allowing any reads outside the working directories',
  '   2. No, and block reads outside the working directories from now on',
  '   3. No, and ask again next time',
  '   4. Yes, but ask again next time',
  ' Esc to cancel · Tab to amend',
  '',
].join('\n');

/** The same dialog as it wraps in the 80-wide pane of a tmux server with no client. */
const AUTO_DIALOG_80 = [
  ' Allow this read outside the working',
  ' directories?',
  ' ❯ 1. Yes, and keep allowing any reads outside the',
  '      working directories',
  '   2. No, and block reads outside the working',
  '      directories from now on',
  '   3. No, and ask again next time',
  '   4. Yes, but ask again next time',
  ' Esc to cancel · Tab to amend',
].join('\n');

/** Claude Code's folder-trust dialog: a real capture. It has its own handling and must never get Esc. */
const TRUST = [
  '─'.repeat(40),
  ' Accessing workspace:',
  ' /home/work/project',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  " Claude Code'll be able to read, edit, and execute files here.",
  ' Security guide',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n');

describe('reading the pane', () => {
  it('finds the permission menu, not the same words in a summary', () => {
    expect(detectPermissionPrompt(PROMPT)).toContain('resolves through a symlink');
    expect(detectPermissionPrompt(PROMPT)).toContain('Do you want to proceed?');
    expect(detectPermissionPrompt('The dialog said: Do you want to proceed?\n❯ \n')).toBeNull();
    expect(detectPermissionPrompt(IDLE_CLAUDE_PANE)).toBeNull();
  });

  it('never sees a prompt in a pane that shows the input box or a working agent (B3)', () => {
    // A summary or tool output quoting the whole menu, with the live box under it.
    expect(detectPermissionPrompt(`${PROMPT}\n${IDLE_CLAUDE_PANE}`)).toBeNull();
    expect(detectPermissionPrompt(`${PROMPT}\n✢ Bunning… (24m 36s · ↓ 66.8k tokens)`)).toBeNull();
  });

  it('finds the real auto-mode dialog, at any width, whatever the question says', () => {
    expect(detectPermissionPrompt(AUTO_DIALOG)).toContain('Allow this read outside the working directories?');
    expect(detectPermissionPrompt(AUTO_DIALOG)).toContain('Read(/etc/hostname)');
    expect(detectPermissionPrompt(AUTO_DIALOG_80)).toContain('directories?');
  });

  it('finds a menu under an old line that looks like work', () => {
    expect(detectPermissionPrompt(`  ⎿  Running… (2m 3s)\nesc to interrupt\n${AUTO_DIALOG}`)).not.toBeNull();
  });

  it('wants the question, the numbered menu and the footer at the bottom of the pane', () => {
    expect(
      detectPermissionPrompt(
        AUTO_DIALOG.replace('Allow this read outside the working directories?', 'Some text.'),
      ),
    ).toBeNull();
    expect(detectPermissionPrompt(AUTO_DIALOG.replace(' Esc to cancel · Tab to amend', ''))).toBeNull();
    expect(detectPermissionPrompt(AUTO_DIALOG.replace('❯ 1. Yes', '  1. Yes'))).toBeNull();
    expect(detectPermissionPrompt(`${AUTO_DIALOG}\nline one\nline two\nline three`)).toBeNull();
  });

  it('does not touch a menu whose Esc would exit Claude (F2)', () => {
    expect(
      detectPermissionPrompt(AUTO_DIALOG.replace('Esc to cancel · Tab to amend', 'Esc to exit')),
    ).toBeNull();
  });

  it('leaves the folder-trust dialog to its own handling', () => {
    expect(detectPermissionPrompt(TRUST)).toBeNull();
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
  it('in the real auto-mode dialog is refused with Esc and nothing else', async () => {
    const { h, id, target, clock } = await setup();
    const press = h.tmux.pressEscape.bind(h.tmux);
    h.tmux.pressEscape = async (t) => {
      await press(t);
      h.tmux.print(t, IDLE_CLAUDE_PANE);
    };
    h.tmux.print(target, AUTO_DIALOG);
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
    await monitor.checkOnce();
    clock.now += 2 * MINUTE;
    await monitor.checkOnce();
    expect(h.window(target).keys.startsWith('<Esc>Automatic check: a permission question')).toBe(true);
    const entry = h.store.history
      .list({ sessionId: id })
      .find((e) => e.text.startsWith('Permission watchdog'));
    expect(entry?.text).toContain('Read(/etc/hostname)');
  });

  it('keeps its two minutes when only a timer above the menu changes', async () => {
    const { h, target, clock } = await setup();
    const press = h.tmux.pressEscape.bind(h.tmux);
    h.tmux.pressEscape = async (t) => {
      await press(t);
      h.tmux.print(t, IDLE_CLAUDE_PANE);
    };
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
    h.tmux.print(target, `  ⎿  Running… (3m 2s)\n${AUTO_DIALOG}`);
    await monitor.checkOnce();
    clock.now += 2 * MINUTE;
    h.tmux.print(target, `  ⎿  Running… (5m 2s)\n${AUTO_DIALOG}`);
    await monitor.checkOnce();
    expect(h.window(target).keys).toContain('<Esc>');
  });

  it('only gets the one-hour alert at a menu whose Esc would exit Claude (F2)', async () => {
    const { h, target, clock } = await setup();
    h.tmux.print(target, AUTO_DIALOG.replace('Esc to cancel · Tab to amend', 'Esc to exit'));
    const onAlert = vi.fn();
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now, onAlert });
    await monitor.checkOnce();
    clock.now += 60 * MINUTE;
    await monitor.checkOnce();
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(h.window(target).keys).toBe('');
  });

  it('never presses anything at the folder-trust dialog', async () => {
    const { h, target, clock } = await setup();
    h.tmux.print(target, TRUST);
    const onAlert = vi.fn();
    const monitor = new UsageLimitMonitor(h.runner, h.store, {
      now: () => clock.now,
      onAlert,
      onTrustPrompt: () => undefined,
    });
    await monitor.checkOnce();
    clock.now += 600 * MINUTE;
    await monitor.checkOnce();
    expect(h.window(target).keys).toBe('');
    expect(onAlert).not.toHaveBeenCalled();
  });

  it('alerts once when a screen that is no input box stays up for an hour', async () => {
    const { h, id, target, clock } = await setup();
    const pr = h.store.pullRequests.create({
      projectId: h.shop.id,
      repo: 'web',
      number: 1,
      url: 'u',
      sessionId: id,
    });
    h.store.pullRequests.update(pr.id, { outcome: 'escalated' }); // so nothing refuses this menu
    h.tmux.print(target, AUTO_DIALOG);
    const onAlert = vi.fn();
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now, onAlert });
    await monitor.checkOnce();
    clock.now += 59 * MINUTE;
    await monitor.checkOnce();
    expect(onAlert).not.toHaveBeenCalled();
    clock.now += MINUTE;
    await monitor.checkOnce();
    clock.now += 600 * MINUTE;
    await monitor.checkOnce();
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(h.window(target).keys).toBe('');
  });

  it('alerts about a dialog it does not know, and presses nothing', async () => {
    const { h, target, clock } = await setup();
    h.tmux.print(target, ' Something new\n Press any key to continue');
    const onAlert = vi.fn();
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now, onAlert });
    await monitor.checkOnce();
    clock.now += 60 * MINUTE;
    await monitor.checkOnce();
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(h.window(target).keys).toBe('');
  });

  it('sends the explanation when typed text of it was left in the box (N-A)', async () => {
    const { h, target, clock } = await setup();
    const press = h.tmux.pressEscape.bind(h.tmux);
    h.tmux.pressEscape = async (t) => {
      await press(t);
      h.tmux.print(t, IDLE_CLAUDE_PANE);
    };
    h.tmux.print(target, AUTO_DIALOG);
    const monitor = new UsageLimitMonitor(h.runner, h.store, {
      now: () => clock.now,
      onError: () => undefined,
    });
    await monitor.checkOnce();
    clock.now += 2 * MINUTE;
    const send = vi.spyOn(h.runner, 'sendToSession').mockImplementationOnce(async (_id, text) => {
      await h.tmux.sendKeys(target, text, { enter: false }); // typed, and then it timed out under load
      throw new Error('did not take the message');
    });
    await monitor.checkOnce();
    await monitor.checkOnce();
    expect(send).toHaveBeenCalledTimes(2);
    expect(h.window(target).output).not.toContain('Automatic check'); // sent this time, and the box emptied
  });

  it('lets the idle reminders run when an owed explanation cannot be sent (N-A)', async () => {
    const { h, id, path, target, clock } = await setup();
    h.git.statuses.set(path, ' M src/a.ts');
    const press = h.tmux.pressEscape.bind(h.tmux);
    h.tmux.pressEscape = async (t) => {
      await press(t);
      h.tmux.print(t, IDLE_CLAUDE_PANE.replace('❯ ', '❯ text someone else left in the box'));
    };
    h.tmux.print(target, AUTO_DIALOG);
    const monitor = new UsageLimitMonitor(h.runner, h.store, {
      now: () => clock.now,
      onError: () => undefined,
    });
    await monitor.checkOnce();
    clock.now += 2 * MINUTE;
    await monitor.checkOnce();
    // The box holds another text: no explanation. It empties, and the owed one goes out.
    h.tmux.print(target, IDLE_CLAUDE_PANE);
    await monitor.checkOnce();
    expect(h.window(target).keys).toContain('Automatic check: a permission question');
    expect(id).toBeGreaterThan(0);
  });
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

  it('keeps being refused after three, with no more paid turns and one alert (B2)', async () => {
    const { h, id, target, clock } = await setup();
    const press = h.tmux.pressEscape.bind(h.tmux);
    h.tmux.pressEscape = async (t) => {
      await press(t);
      h.tmux.print(t, IDLE_CLAUDE_PANE);
    };
    const onAlert = vi.fn();
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now, onAlert });
    for (let cycle = 0; cycle < 25; cycle++) {
      h.tmux.print(target, PROMPT); // the agent tried again
      await monitor.checkOnce();
      clock.now += 2 * MINUTE;
      await monitor.checkOnce();
    }
    const keys = h.window(target).keys;
    expect(keys.split('<Esc>')).toHaveLength(26); // every menu closed, so none can block the session
    expect(keys.split('Automatic check: a permission question')).toHaveLength(4);
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0]?.[1]).toMatch(/permission/);
    expect(
      h.store.history.count({ sessionId: id, kind: 'decision', prefix: 'Permission watchdog: refused' }),
    ).toBe(25);
  });

  it('counts refusals per task: a new task starts again', async () => {
    const { h, id, target, clock } = await setup();
    const press = h.tmux.pressEscape.bind(h.tmux);
    h.tmux.pressEscape = async (t) => {
      await press(t);
      h.tmux.print(t, IDLE_CLAUDE_PANE);
    };
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
    for (let cycle = 0; cycle < 5; cycle++) {
      h.tmux.print(target, PROMPT);
      await monitor.checkOnce();
      clock.now += 2 * MINUTE;
      await monitor.checkOnce();
    }
    const storeClock = h.store.clock as FakeClock;
    storeClock.advance(1000);
    h.store.requests.create({ projectId: h.shop.id, sessionId: id, text: 'next task', source: 'dashboard' });
    storeClock.advance(1000);
    h.tmux.print(target, PROMPT);
    h.window(target).keys = '';
    await monitor.checkOnce();
    clock.now += 2 * MINUTE;
    await monitor.checkOnce();
    expect(h.window(target).keys).toContain('Automatic check: a permission question');
  });

  it('sends the explanation again when sending it failed (N7)', async () => {
    const { h, target, clock } = await setup();
    const press = h.tmux.pressEscape.bind(h.tmux);
    h.tmux.pressEscape = async (t) => {
      await press(t);
      h.tmux.print(t, IDLE_CLAUDE_PANE);
    };
    h.tmux.print(target, PROMPT);
    const onError = vi.fn();
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now, onError });
    await monitor.checkOnce();
    clock.now += 2 * MINUTE;
    vi.spyOn(h.runner, 'sendToSession').mockRejectedValueOnce(new Error('no input box'));
    await monitor.checkOnce();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(h.window(target).keys).toBe('<Esc>');
    await monitor.checkOnce();
    expect(h.window(target).keys).toContain('Automatic check: a permission question');
    const again = h.window(target).keys;
    await monitor.checkOnce();
    expect(h.window(target).keys).toBe(again); // once
  });

  it('is left to the human whose PR it took over (N9)', async () => {
    const { h, id, target, clock } = await setup();
    const pr = h.store.pullRequests.create({
      projectId: h.shop.id,
      repo: 'web',
      number: 1,
      url: 'u',
      sessionId: id,
    });
    h.store.pullRequests.update(pr.id, { outcome: 'escalated' });
    h.tmux.print(target, PROMPT);
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
    await monitor.checkOnce();
    clock.now += 60 * MINUTE;
    await monitor.checkOnce();
    expect(h.window(target).keys).toBe('');
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
    const onAlert = vi.fn();
    const options = { now: () => clock.now, onAlert };
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
    expect(onAlert).not.toHaveBeenCalled();
    clock.now += 6 * MINUTE;
    await monitor.checkOnce();
    expect(onAlert).toHaveBeenCalledTimes(1);
    clock.now += 600 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(3);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it('keeps the count past 50 other history entries (N5)', async () => {
    const { h, id, path, clock } = await setup();
    h.git.statuses.set(path, ' M src/a.ts');
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
    await monitor.checkOnce();
    clock.now += 30 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(1);
    for (let i = 0; i < 60; i++) {
      h.store.history.add({ projectId: h.shop.id, sessionId: id, kind: 'decision', text: `other ${i}` });
    }
    clock.now += 31 * MINUTE; // past the first limit, not the second: a lost count would nudge again
    await monitor.checkOnce();
    expect(h.store.history.count({ sessionId: id, kind: 'decision', prefix: 'Idle watchdog nudge' })).toBe(1);
  });

  it('counts a dim suggestion in the box as an empty box, so reminders keep coming', async () => {
    const { h, id, path, target, clock } = await setup();
    h.git.statuses.set(path, ' M src/a.ts');
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
    const withGhost = (text: string) => IDLE_CLAUDE_PANE.replace('❯ ', `❯\u00a0\u001b[2m${text}\u001b[22m`);
    h.tmux.print(target, withGhost('open the pull request'));
    await monitor.checkOnce();
    clock.now += 30 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(1);
    h.tmux.print(target, withGhost('try again'));
    await monitor.checkOnce();
    clock.now += 120 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(2);
  });

  it('asks about a text of its own left in the box, and sends it (a timeout under load)', async () => {
    const { h, id, path, target, clock } = await setup();
    h.git.statuses.set(path, ' M src/a.ts');
    const monitor = new UsageLimitMonitor(h.runner, h.store, {
      now: () => clock.now,
      onError: () => undefined,
    });
    await monitor.checkOnce();
    clock.now += 30 * MINUTE;
    vi.spyOn(h.runner, 'sendToSession').mockImplementationOnce(async (_id, text) => {
      await h.tmux.sendKeys(target, text, { enter: false });
      throw new Error('did not take the message');
    });
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(0);
    clock.now += 6 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(1);
  });

  it("leaves a person's pasted draft in the box alone (F1)", async () => {
    const { h, id, path, target, clock } = await setup();
    h.git.statuses.set(path, ' M src/a.ts');
    h.tmux.print(target, IDLE_CLAUDE_PANE.replace('❯ ', '❯ [Pasted text #1 +4 lines]'));
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
    await monitor.checkOnce();
    clock.now += 500 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(0);
    expect(h.window(target).keys).toBe('');
  });

  it('does not take leftover refusal text for a person typing, after a restart (F3)', async () => {
    const { h, id, path, target, clock } = await setup();
    h.git.statuses.set(path, ' M src/a.ts');
    const refused =
      'Automatic check: a permission question waited and was refused, because nobody can approve it here. ' +
      'Find another way to do this inside your working folder.';
    h.tmux.print(target, IDLE_CLAUDE_PANE.replace('❯ ', `❯ ${refused}`));
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
    await monitor.checkOnce();
    clock.now += 30 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(1);
  });

  it('tells a builder with a hung run or a long-lived server what is still due', async () => {
    const { h, path, target, clock } = await setup();
    h.git.statuses.set(path, ' M src/a.ts');
    h.tmux.print(target, `${IDLE_CLAUDE_PANE} · 1 shell`);
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
    await monitor.checkOnce();
    clock.now += 45 * MINUTE;
    await monitor.checkOnce();
    const keys = h.window(target).keys;
    expect(keys).toContain('may have hung');
    expect(keys).toContain('open the pull request');
    expect(keys.length).toBeLessThanOrEqual(800); // over this the send path refuses it
  });

  it('tells it not to delete what it did not create', async () => {
    const { h, path, target, clock } = await setup();
    h.git.statuses.set(path, '?? notes.txt');
    const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
    await monitor.checkOnce();
    clock.now += 30 * MINUTE;
    await monitor.checkOnce();
    const keys = h.window(target).keys;
    expect(keys).toContain('Do not delete');
    expect(keys).not.toMatch(/remove the leftover/);
  });

  describe('with a PR in the loop', () => {
    const FEEDBACK = { kind: 'review', items: ['fix x'], sha: 'abc', sentAt: '2026-10-18T09:00:00.000Z' };
    const withPr = (h: Harness, id: number, loopState: Record<string, unknown>, number = 1) => {
      const pr = h.store.pullRequests.create({
        projectId: h.shop.id,
        repo: 'web',
        number,
        url: 'u',
        sessionId: id,
      });
      return h.store.pullRequests.update(pr.id, { loopState });
    };

    it('reminds a builder that owes an answer to feedback, with the same gaps and cap', async () => {
      const { h, id, target, clock } = await setup();
      withPr(h, id, { feedback: FEEDBACK });
      const onAlert = vi.fn();
      const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now, onAlert });
      await monitor.checkOnce();
      clock.now += 29 * MINUTE;
      await monitor.checkOnce();
      expect(nudges(h, id)).toBe(0);
      clock.now += MINUTE;
      await monitor.checkOnce();
      expect(nudges(h, id)).toBe(1);
      expect(h.window(target).keys).toContain('feedback');
      expect(h.window(target).keys).not.toContain('open the pull request');
      for (const minutes of [120, 360]) {
        clock.now += minutes * MINUTE;
        await monitor.checkOnce();
      }
      expect(nudges(h, id)).toBe(3);
      clock.now += 360 * MINUTE;
      await monitor.checkOnce();
      expect(nudges(h, id)).toBe(3);
      expect(onAlert).toHaveBeenCalledTimes(1);
    });

    it('reminds it after 45 minutes when a background run may have hung (s23, s34)', async () => {
      const { h, id, target, clock } = await setup();
      withPr(h, id, { feedback: FEEDBACK });
      h.tmux.print(target, `${IDLE_CLAUDE_PANE} · 1 shell`);
      const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
      await monitor.checkOnce();
      clock.now += 44 * MINUTE;
      await monitor.checkOnce();
      expect(nudges(h, id)).toBe(0);
      clock.now += MINUTE;
      await monitor.checkOnce();
      expect(nudges(h, id)).toBe(1);
      const keys = h.window(target).keys;
      expect(keys).toContain('may have hung');
      expect(keys).toContain('feedback');
      expect(keys).not.toContain('open the pull request');
      expect(keys.length).toBeLessThanOrEqual(800);
    });

    it('needs nothing undelivered to remind about feedback: the fix is what is missing', async () => {
      const { h, id, path, clock } = await setup();
      h.git.statuses.set(path, '');
      withPr(h, id, { feedback: FEEDBACK });
      const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
      await monitor.checkOnce();
      clock.now += 30 * MINUTE;
      await monitor.checkOnce();
      expect(nudges(h, id)).toBe(1);
    });

    it.each([
      ['the loop is running its checks', (h: Harness, id: number) => withPr(h, id, {})],
      [
        'the feedback has not reached the builder yet',
        (h: Harness, id: number) => withPr(h, id, { feedback: { ...FEEDBACK, sentAt: null } }),
      ],
      [
        'a human was asked about it',
        (h: Harness, id: number) => {
          withPr(h, id, { feedback: FEEDBACK });
          h.store.questions.create({ sessionId: id, text: 'q', options: ['a'], recommendedOption: 'a' });
        },
      ],
      [
        'it was escalated to a human',
        (h: Harness, id: number) => {
          const pr = withPr(h, id, {});
          h.store.pullRequests.update(pr.id, { stage: 'escalated' });
        },
      ],
      [
        'a human took over a PR of the session',
        (h: Harness, id: number) => {
          withPr(h, id, { feedback: FEEDBACK }, 1);
          const pr = withPr(h, id, {}, 2);
          h.store.pullRequests.update(pr.id, { outcome: 'escalated' });
        },
      ],
    ])('leaves it alone while %s', async (_name, arrange) => {
      const { h, id, path, target, clock } = await setup();
      h.git.statuses.set(path, ' M src/a.ts');
      arrange(h, id);
      const monitor = new UsageLimitMonitor(h.runner, h.store, { now: () => clock.now });
      await monitor.checkOnce();
      clock.now += 500 * MINUTE;
      await monitor.checkOnce();
      expect(nudges(h, id)).toBe(0);
      expect(h.window(target).keys).toBe('');
    });
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

  it('is not idle while it works, or before 45 minutes with a background shell', async () => {
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
    clock.now += 44 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(0);
    clock.now += MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(1);
    expect(h.window(target).keys).toContain('may have hung');
    expect(h.window(target).keys).toContain('timeout');

    // A server that keeps "1 shell" showing doesn't mute it, and the same limits apply.
    clock.now += 120 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(2);
    clock.now += 360 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(3);
    clock.now += 720 * MINUTE;
    await monitor.checkOnce();
    expect(nudges(h, id)).toBe(3);
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
