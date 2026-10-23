// C0 controls (tab, CR, LF, ESC included), DEL, C1 controls, and U+2028/U+2029.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** One line of plain text: control characters become spaces, runs of spaces collapse. */
export function sanitizeLine(text: string): string {
  return text.replace(CONTROL_CHARS, ' ').replace(/ {2,}/g, ' ').trim();
}
