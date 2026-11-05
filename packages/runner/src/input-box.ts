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

// eslint-disable-next-line no-control-regex
const ESCAPES = /\u001b\[([0-9;:]*)([A-Za-z])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

interface Styled {
  text: string;
  dim: boolean;
  reverse: boolean;
}

/** The SGR codes' effect on dim and reverse; the arguments of a 38 or 48 colour are skipped. */
function applyStyle(codes: string, style: { dim: boolean; reverse: boolean }): void {
  const list = codes === '' ? [0] : codes.split(/[;:]/).map(Number);
  for (let i = 0; i < list.length; i++) {
    const code = list[i];
    if (code === 38 || code === 48 || code === 58) i += list[i + 1] === 2 ? 4 : 2;
    else if (code === 0) Object.assign(style, { dim: false, reverse: false });
    else if (code === 2) style.dim = true;
    else if (code === 22) style.dim = false;
    else if (code === 7) style.reverse = true;
    else if (code === 27) style.reverse = false;
  }
}

/**
 * A pane captured with its styles, as plain text without the suggestion Claude shows in its empty
 * input box. That suggestion ("try again") is dim, and nobody typed it. Only the box loses dim text:
 * elsewhere it can matter. Claude can draw its cursor, a reversed cell, on the suggestion's first letter.
 */
export function plainPane(styled: string): string {
  const style = { dim: false, reverse: false };
  const lines = styled.split('\n').map((line) => {
    const parts: Styled[] = [];
    let at = 0;
    for (const match of line.matchAll(ESCAPES)) {
      if (match.index > at) parts.push({ text: line.slice(at, match.index), ...style });
      if (match[2] === 'm') applyStyle(match[1] ?? '', style);
      at = match.index + match[0].length;
    }
    if (at < line.length) parts.push({ text: line.slice(at), ...style });
    return parts;
  });
  const text = (parts: Styled[]) => parts.map((p) => p.text).join('');
  const prompt = lines.findLastIndex((parts) => {
    const line = text(parts);
    return PROMPT.test(line) && !MENU_CHOICE.test(line);
  });
  return lines
    .map((parts, i) => {
      const end = prompt < 0 ? -1 : lines.findIndex((l, n) => n > prompt && RULE.test(text(l)));
      const inBox = prompt >= 0 && i >= prompt && (end < 0 || i < end);
      if (!inBox) return text(parts);
      const kept = text(
        parts.filter((p, n) => !p.dim && !(p.reverse && p.text.trim().length === 1 && parts[n + 1]?.dim)),
      );
      // The mark itself can be caught in a dim stretch: the box is still there.
      return i === prompt && !PROMPT.test(kept) ? '❯ ' : kept;
    })
    .join('\n');
}

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

/** Claude shows only the last lines of a long text. Less than this at its end could be anything. */
const MIN_VISIBLE_END = 40;

/** Whether the box shows the text, or enough of its end when the rest no longer fits. */
function shows(box: string, typed: string): boolean {
  const shown = bare(box);
  const text = bare(typed);
  return shown.includes(text) || (shown.length >= MIN_VISIBLE_END && text.endsWith(shown));
}

/** Whether the box shows `typed` itself (wrapping and spacing ignored). */
export function inputBoxHasText(pane: string, typed: string): boolean {
  const box = inputBoxText(pane);
  return !!box && shows(box, typed);
}

/** Whether `typed`, just typed, may still sit unsubmitted in the box: itself, or folded as a paste. */
export function inputBoxHolds(pane: string, typed: string): boolean {
  const box = inputBoxText(pane);
  return !!box && (PASTE_PLACEHOLDER.test(box) || shows(box, typed));
}
