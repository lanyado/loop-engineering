/**
 * Claude Code's input box: a rule (which may carry the session title), the "❯" prompt line and any
 * wrapped lines, a closing rule, then at most a few status lines and no other rule. Text typed by the
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

/** What Claude shows instead of a long paste (or of its start). */
const PASTE_PLACEHOLDER = /\[Pasted text #\d+|paste again to expand/i;

/** The text in Claude's input box, or null when the bottom of the pane is not Claude's input box. */
export function inputBoxText(pane: string): string | null {
  const lines = pane.replace(/\n+$/, '').split('\n');
  const rules = lines.flatMap((line, i) => (RULE.test(line) ? [i] : []));
  if (rules.length < 2) return null;
  const [top, bottom] = rules.slice(-2) as [number, number];
  const box = lines.slice(top + 1, bottom);
  const status = lines.slice(bottom + 1).filter((l) => l.trim() !== '');
  if (box.length === 0 || box.length > MAX_BOX_LINES || status.length > MAX_STATUS_LINES) return null;
  if (!PROMPT.test(box[0]!)) return null;
  return box.join(' ').replace(PROMPT, '').replace(/\s+/g, ' ').trim();
}

/** Whether `typed` still sits unsubmitted in Claude's input box (wrapping and spacing ignored). */
export function inputBoxHolds(pane: string, typed: string): boolean {
  const box = inputBoxText(pane);
  if (!box) return false;
  const bare = (s: string) => s.replace(/\s+/g, '');
  return PASTE_PLACEHOLDER.test(box) || bare(box).includes(bare(typed));
}
