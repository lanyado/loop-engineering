import { describe, expect, it } from 'vitest';
import { inputBoxHasText, inputBoxHolds, inputBoxText, plainPane } from './input-box.js';

const SENTENCE = 'New review feedback for PR #7 is in .loop/pr28-round1-review.md. Read it and address it.';

// Taken from a live Claude Code pane (v2.1), trimmed.
const IDLE = [
  '⏺ Compacted while idle, before the prompt cache expired',
  '❯ Resumed: the session was paused (agent_exited). Continue where you left off.',
  '  Reading the PR review feedback file',
  '───────────────────────────── משימה חדשה- לעדכן את דף הקשר ─',
  '❯ ',
  '────────────────────────────────────────────────────────────',
  '  ⚡Boost 10.9K saved',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · PR #7 · ← 1 agent',
].join('\n');

const holding = (...input: string[]) =>
  IDLE.replace(
    '❯ \n',
    `❯ ${input[0]}\n${input
      .slice(1)
      .map((l) => `  ${l}\n`)
      .join('')}`,
  );

describe('plainPane', () => {
  const ESC = '\u001b';
  const box = (inner: string) => ['─'.repeat(20), inner, '─'.repeat(20), '  ⏵⏵ auto mode on'].join('\n');

  it('drops a dim suggestion from the box, with or without Claude drawing its cursor on it', () => {
    expect(inputBoxText(plainPane(box(`❯\u00a0${ESC}[2mtry again${ESC}[22m`)))).toBe('');
    expect(
      inputBoxText(plainPane(box(`${ESC}[39m❯\u00a0${ESC}[7mt${ESC}[27m${ESC}[2mry again${ESC}[0m`))),
    ).toBe('');
  });

  it('keeps what was typed, and text outside the box even when dim', () => {
    expect(inputBoxText(plainPane(box(`❯ fix x${ESC}[2m and more${ESC}[0m`)))).toBe('fix x');
    expect(plainPane(`${ESC}[2mdim output${ESC}[0m\n${box('❯ ')}`)).toContain('dim output');
  });

  it('does not read a colour number as dim, and carries dim across lines', () => {
    expect(inputBoxText(plainPane(box(`❯ ${ESC}[38;5;2mgreen${ESC}[39m`)))).toBe('green');
    expect(inputBoxText(plainPane(`${ESC}[2m${box('❯ carried')}`))).toBe('');
  });

  it('strips colours and links from a real status line', () => {
    const line = `${ESC}[39m  ${ESC}[38;5;220m⏵⏵ auto mode on${ESC}[38;5;246m · PR${ESC}[39m ${ESC}[4m${ESC}[38;5;220m${ESC}]8;id=1;https://github.com/me/web/pull/38${ESC}\\#38${ESC}[0m${ESC}[38;5;246m${ESC}]8;;${ESC}\\ · ${ESC}[38;5;44m1 shell${ESC}[39m`;
    expect(plainPane(line)).toBe('  ⏵⏵ auto mode on · PR #38 · 1 shell');
  });
});

/** Claude Code 2.1.318, 80x24, 600 characters typed: only the end of the text shows. A real capture. */
describe('a long text in a small pane', () => {
  const text = Array.from({ length: 75 }, (_, i) => `word${String(i).padStart(3, '0')}`)
    .join(' ')
    .slice(0, 600);
  const pane = [
    '─'.repeat(27),
    '❯ word018 word019 word020 word021 word022 word023 word024 word025 word026',
    '  word027 word028 word029 word030 word031 word032 word033 word034 word035',
    '  word036 word037 word038 word039 word040 word041 word042 word043 word044',
    '  word045 word046 word047 word048 word049 word050 word051 word052 word053',
    '  word054 word055 word056 word057 word058 word059 word060 word061 word062     ',
    '  word063 word064 word065 word066 word067 word068 word069 word070 word071       ',
    '  word072 word073 word074        ',
    '─'.repeat(27),
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n');

  it('holds it when the visible end matches', () => {
    expect(inputBoxHolds(pane, text)).toBe(true);
    expect(inputBoxHasText(pane, text)).toBe(true);
    expect(inputBoxHolds(pane, `${text} and more`)).toBe(false);
  });

  it('does not take a short or foreign box for a long text', () => {
    const small = ['─'.repeat(27), '❯ word074', '─'.repeat(27)].join('\n');
    expect(inputBoxHolds(small, text)).toBe(false);
  });
});

describe('inputBoxText', () => {
  it('reads the box between the last two rules, without the prompt mark', () => {
    expect(inputBoxText(IDLE)).toBe('');
    expect(inputBoxText(holding('fix it'))).toBe('fix it');
  });

  it('is null when the pane shows no input box', () => {
    expect(inputBoxText('opencode\n> type here')).toBeNull();
    expect(inputBoxText('')).toBeNull();
  });
});

describe('a title as wide as the pane', () => {
  // Taken from live panes: the title fills the rule, so no "─" comes before it (or any, in Hebrew).
  const wide = (title: string, ...box: string[]) =>
    [
      '✻ Worked for 37m 44s · done 2:55 PM',
      '❯ Read the file .loop/request-3.md',
      '  and handle that request.',
      title,
      ...box,
      '────────────────────────────────────────',
      '',
      '  ⏵⏵ auto mode on (shift+tab to cycle) · PR #14',
    ].join('\n');
  const hebrew = ' בדף ההגדרות: להחליף את הכפתור שבראש הדף בכפתור חדש, כלומר רק ';
  const english = ' From the owner. The files the requester attached to the email have now reach… ─';

  it('still shows the box, empty or holding text', () => {
    expect(inputBoxText(wide(hebrew, '❯ '))).toBe('');
    expect(inputBoxText(wide(english, '❯ '))).toBe('');
    expect(inputBoxText(wide(english, '❯ Read the file', '  now'))).toBe('Read the file now');
    expect(inputBoxHolds(wide(hebrew, `❯ ${SENTENCE}`), SENTENCE)).toBe(true);
  });

  it('does not read a dialog or a message already sent as the box', () => {
    expect(inputBoxText(wide(english, '❯ 1. Yes', '  2. No'))).toBeNull();
    // Nothing but a sent message above the rule, with no title line over it.
    expect(inputBoxText(['', '❯ Old message', '────────────', '  status'].join('\n'))).toBeNull();
    expect(inputBoxText(['❯ Older', '❯ Old message', '────────────', '  status'].join('\n'))).toBeNull();
  });

  it('does not read the dialog that shows such a title under its choices as the box', () => {
    const dialog = [
      '────────────────────────────────────────',
      ' Read outside the working directories',
      ' Read(/srv/loops/incoming/a.png)',
      ' Auto mode and the sandbox read outside the working directories without asking.',
      ' Yes or No answers for this read; the rest is for later reads.',
      ' Allow this read outside the working directories?',
      ' ❯ 1. Yes, and keep allowing any reads outside the working directories',
      '   2. No, and block reads outside the working directories from now on',
      '   3. No, and ask again next time',
      '   4. Yes, but ask again next time',
      ' Esc to cancel · Tab to amend',
      english,
    ].join('\n');
    expect(inputBoxText(dialog)).toBeNull();
  });
});

describe('inputBoxHolds', () => {
  it('is true while the typed sentence sits in the box, wrapped or not', () => {
    expect(inputBoxHolds(holding(SENTENCE), SENTENCE)).toBe(true);
    expect(
      inputBoxHolds(
        holding(
          'New review feedback for PR #7 is in',
          '.loop/pr28-round1-review.md. Read it and',
          'address it.',
        ),
        SENTENCE,
      ),
    ).toBe(true);
  });

  it('is true for a paste Claude folded into a placeholder', () => {
    expect(inputBoxHolds(holding('[Pasted text #1 +3 lines]'), SENTENCE)).toBe(true);
  });

  it('is false once it was sent: the same text above the box does not count', () => {
    expect(inputBoxHolds(`❯ ${SENTENCE}\n${IDLE}`, SENTENCE)).toBe(false);
  });

  it('is false for other text in the box, and for a pane with no box', () => {
    expect(inputBoxHolds(holding('something the human is typing'), SENTENCE)).toBe(false);
    expect(inputBoxHolds('no box here', SENTENCE)).toBe(false);
  });

  // Live Claude Code 2.1.316: while it works, a queued message leaves the box and this hint takes its place.
  it('reads a busy agent with a queued message as no longer holding it', () => {
    expect(inputBoxHolds(holding('Press up to edit queued messages'), SENTENCE)).toBe(false);
  });
});

describe('what is not the input box', () => {
  // Claude 2.1's permission dialog: a top rule and no closing one under it.
  const DIALOG = [
    '❯ ' + SENTENCE,
    '───────────────────────────────',
    '❯ old text',
    '───────────────────────────────',
    ' Bash command',
    '   npm test',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again",
    '   3. No, and tell Claude what to do differently (esc)',
  ].join('\n');

  it('a dialog under the last rules is not the box, so nothing is typed into it', () => {
    expect(inputBoxText(DIALOG)).toBeNull();
    expect(inputBoxHolds(DIALOG, SENTENCE)).toBe(false);
  });

  it('a region that does not start with the prompt mark is not the box', () => {
    expect(inputBoxText(['──────', 'some output', '──────', 'status'].join('\n'))).toBeNull();
  });
});
