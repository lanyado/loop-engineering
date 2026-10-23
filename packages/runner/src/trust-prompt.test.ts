import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { harness } from './test-support/harness.js';
import { detectTrustPrompt, TRUST_LATER, trustQuestion } from './trust-prompt.js';

const DIALOG = `
 Accessing workspace:
 /wt/shop/x/web
 Quick safety check: Is this a project you created or one you trust? (Like your own code, a
 well-known open source project, or work from your team).
 Claude Code'll be able to read, edit, and execute files here.
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
`;

/** Real Claude Code 2.1.302 dialogs captured with `capture-pane -p -J` at several window widths. */
const CAPTURES = new URL('./test-support/trust-dialog/', import.meta.url);
const captures = readdirSync(CAPTURES).filter((f) => f.endsWith('.txt'));

describe('detectTrustPrompt', () => {
  it.each(captures)('detects the real dialog in %s', (file) => {
    const pane = readFileSync(new URL(file, CAPTURES), 'utf8');
    expect(detectTrustPrompt(pane)).toBe(true);
  });

  it('has the narrow captures, where the question sentence wraps', () => {
    expect(captures).toEqual(
      expect.arrayContaining(['claude-2.1.302-40-cols.txt', 'claude-2.1.302-50-cols.txt']),
    );
    const narrow = readFileSync(new URL('claude-2.1.302-40-cols.txt', CAPTURES), 'utf8');
    expect(narrow).toContain(' Quick safety check: Is this a project\n you created or one you trust?');
    // Without "Accessing workspace:" (scrolled off, or a very long path), the wrapped sentence is enough.
    expect(detectTrustPrompt(narrow.replace(' Accessing workspace:', ''))).toBe(true);
    expect(
      detectTrustPrompt(narrow.replace(' Accessing workspace:', '').replace('Quick safety check: ', '')),
    ).toBe(true);
  });

  it('ignores a quoted narrow dialog above the input box, and a narrow dialog with no footer', () => {
    const narrow = readFileSync(new URL('claude-2.1.302-40-cols.txt', CAPTURES), 'utf8');
    expect(
      detectTrustPrompt(
        `${narrow}\n⏺ That was the dialog.\n────────────\n❯ \n────────────\n  ? for shortcuts\n`,
      ),
    ).toBe(false);
    expect(detectTrustPrompt(narrow.replace(' Enter to confirm · Esc to cancel', ''))).toBe(false);
  });

  it("matches Claude's trust dialog, with either choice selected, and the older wording", () => {
    expect(detectTrustPrompt(DIALOG)).toBe(true);
    expect(detectTrustPrompt(DIALOG.replace('❯ No, exit', '  No, exit').replace('  Yes,', '❯ Yes,'))).toBe(
      true,
    );
    expect(
      detectTrustPrompt(
        ' Do you trust the files in this folder?\n ❯ 1. Yes, proceed\n   2. No, exit\n Enter to confirm · Esc to exit\n',
      ),
    ).toBe(true);
  });

  it('ignores an agent or a request quoting the dialog: the frame must be the bottom of the pane', () => {
    // The agent quotes the whole dialog, then Claude's normal input box follows.
    const quoted = `> Add a doc about this prompt:\n${DIALOG}\n⏺ I'll document it.\n────\n❯ \n────\n  ? for shortcuts\n`;
    expect(detectTrustPrompt(quoted)).toBe(false);
    // Only the choice line, quoted near the bottom.
    expect(
      detectTrustPrompt('⏺ The dialog offers:\n   Yes, I trust this folder\n❯ \n  ? for shortcuts\n'),
    ).toBe(false);
    // Question and choice without the footer.
    expect(detectTrustPrompt(DIALOG.replace(' Enter to confirm · Esc to cancel', ''))).toBe(false);
    // Footer last but no question line.
    expect(detectTrustPrompt('   Yes, I trust this folder\n Enter to confirm · Esc to cancel\n')).toBe(false);
    // A footer with a visible input box is not the dialog either.
    expect(
      detectTrustPrompt(`${DIALOG.replace(' Enter to confirm', '  ? for shortcuts\n Enter to confirm')}`),
    ).toBe(false);
    expect(detectTrustPrompt(`${DIALOG}${'working…\n'.repeat(40)}`)).toBe(false);
    expect(detectTrustPrompt('')).toBe(false);
  });
});

describe('trustQuestion', () => {
  it('names the session, the folder and the exact tmux command, and defaults to doing nothing', () => {
    const q = trustQuestion(4, 'loop:@9', '/wt/shop/x/web', new Date('2026-10-18T09:05:30Z'));
    expect(q.text).toContain('Session 4 is waiting');
    expect(q.text).toContain('(window loop:@9, seen 2026-10-18 09:05 UTC)');
    expect(q.text).toContain('/wt/shop/x/web');
    expect(q.context).toContain('tmux attach -t loop:@9');
    expect(q.context).toContain('main checkout');
    expect(q.options).toContain(q.recommendedOption);
    expect(q.recommendedOption).toBe(TRUST_LATER);
  });

  it('differs per launch, so the question service never folds a new report into an old one', () => {
    const at = new Date('2026-10-18T09:00:00Z');
    const later = new Date('2026-10-18T09:20:00Z');
    expect(trustQuestion(4, 'loop:@9', '/f', at).text).not.toBe(trustQuestion(4, 'loop:@10', '/f', at).text);
    expect(trustQuestion(4, 'loop:@9', '/f', at).text).not.toBe(
      trustQuestion(4, 'loop:@9', '/f', later).text,
    );
  });
});

describe('SessionRunner.checkTrustPrompt', () => {
  it('returns the folder of a Claude session at the dialog, and null otherwise', async () => {
    const h = harness();
    const s = await h.runner.startSession(h.shop.id, { text: 'x' });
    expect(await h.runner.checkTrustPrompt(s.id)).toBeNull();
    h.tmux.print(s.tmuxTarget ?? '', DIALOG);
    expect(await h.runner.checkTrustPrompt(s.id)).toMatchObject({
      session: { id: s.id },
      folder: '/wt/shop/x-sfx1/web',
    });
    // Nothing is typed into the window: trusting a folder is the human's call.
    expect(h.window(s.tmuxTarget).keys).toBe('');
    await h.runner.pause(s.id, 'manual');
    expect(await h.runner.checkTrustPrompt(s.id)).toBeNull();
  });
});
