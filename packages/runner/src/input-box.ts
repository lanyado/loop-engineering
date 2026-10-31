/**
 * Claude Code's input box: the lines between the last two horizontal rules of the pane (the top rule
 * may carry the session title). Text typed by the runner that is still in the box was never
 * submitted: an Enter that arrives with the typed text can be read as part of a paste, and the
 * message then waits there unseen while the loop believes it was delivered. Messages already sent
 * show above the box with the same "❯" mark, so only the box itself counts. A pane with no box
 * (another CLI, a dialog, a different layout) never counts as holding the text.
 */

/** A rule line: at least three "─", optionally with a title between them. */
const RULE = /^\s*─{3,}.*─\s*$/;

/** What Claude shows instead of a long paste. */
const PASTE_PLACEHOLDER = /\[Pasted text #\d+/;

/** This much of the start of the typed text identifies it (the box wraps the rest). */
const PROBE_CHARS = 30;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The text in Claude's input box, or null when the pane shows no input box. */
export function inputBoxText(pane: string): string | null {
  const lines = pane.split('\n');
  const rules = lines.flatMap((line, i) => (RULE.test(line) ? [i] : []));
  if (rules.length < 2) return null;
  const [top, bottom] = rules.slice(-2) as [number, number];
  return squash(
    lines
      .slice(top + 1, bottom)
      .join(' ')
      .replace(/^\s*[❯>]/, ''),
  );
}

/** Whether `typed` still sits unsubmitted in Claude's input box. */
export function inputBoxHolds(pane: string, typed: string): boolean {
  const box = inputBoxText(pane);
  if (!box) return false;
  return PASTE_PLACEHOLDER.test(box) || box.includes(squash(typed).slice(0, PROBE_CHARS));
}
