/**
 * Claude Code's input box: a rule (which may carry the session title), the "❯" prompt line and any
 * wrapped lines, a closing rule, then at most a few status lines and no other rule. A title as wide as
 * the pane leaves no "─" before it, so the top rule is then the line above the prompt. Text typed by the
 * runner that is still in the box was never submitted: an Enter that arrives with the typed text can
 * be read as part of a paste, and the message then waits there unseen while the loop believes it was
 * delivered. Messages already sent show above the box with the same "❯" mark, so only the box itself
 * counts. Anything else at the bottom of the pane (a dialog, a screen still starting, another CLI) is
 * no box: null, and the runner does not type into it.
 */

/** A rule line: at least four "─", optionally with a title between them. */
const RULE = /^\s*─{3,}.*─\s*$/;

/** The prompt mark that opens the box. */
const PROMPT = /^\s*[❯>](?:\s|$)/;

/** Status lines Claude draws under the box (mode, hints, plugins); a dialog's body is longer. */
const MAX_STATUS_LINES = 4;

/** The box grows with the typed text; a region taller than this is not the box. */
const MAX_BOX_LINES = 15;

/** A choice in a dialog, which also carries the prompt mark. */
const MENU_CHOICE = /^\s*[❯>]\s*\d+\./;

/** What Claude shows instead of a multi-line or long paste. */
const PASTE_PLACEHOLDER = /\[Pasted text #\d+/;

/** The text in Claude's input box, or null when the bottom of the pane is not Claude's input box. */
export function inputBoxText(pane: string): string | null {
  const lines = pane.replace(/\n+$/, '').split('\n');
  const rules = lines.flatMap((line, i) => (RULE.test(line) ? [i] : []));
  const bottom = rules.at(-1);
  if (bottom === undefined) return null;
  const status = lines.slice(bottom + 1).filter((l) => l.trim() !== '');
  if (status.length > MAX_STATUS_LINES) return null;
  const top = rules.at(-2);
  let box = top === undefined ? [] : lines.slice(top + 1, bottom);
  if (box.length === 0 || box.length > MAX_BOX_LINES || !PROMPT.test(box[0]!)) {
    // No top rule to be seen: the prompt nearest the closing rule, under a line that can be the title.
    const start =
      bottom -
      1 -
      lines
        .slice(0, bottom)
        .reverse()
        .findIndex((l) => PROMPT.test(l));
    const title = lines[start - 1];
    if (start < 1 || bottom - start > MAX_BOX_LINES || !PROMPT.test(lines[start] ?? '')) return null;
    if (MENU_CHOICE.test(lines[start]!) || !title?.trim() || PROMPT.test(title)) return null;
    box = lines.slice(start, bottom);
  }
  return box.join(' ').replace(PROMPT, '').replace(/\s+/g, ' ').trim();
}

const bare = (s: string) => s.replace(/\s+/g, '');

/** Whether the box shows `typed` itself (wrapping and spacing ignored). */
export function inputBoxHasText(pane: string, typed: string): boolean {
  const box = inputBoxText(pane);
  return !!box && bare(box).includes(bare(typed));
}

/** Whether `typed`, just typed, may still sit unsubmitted in the box: itself, or folded as a paste. */
export function inputBoxHolds(pane: string, typed: string): boolean {
  const box = inputBoxText(pane);
  return !!box && (PASTE_PLACEHOLDER.test(box) || bare(box).includes(bare(typed)));
}
