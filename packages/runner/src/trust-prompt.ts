/**
 * Claude Code's folder-trust dialog. Claude wraps its own text to the window width (below about 70
 * columns the question sentence spans several lines), so the question is matched on the dialog's
 * lines joined into one string; the choice and the footer are short and matched as whole lines.
 * The dialog must be the bottom of the pane: the footer is the last non-empty line and nothing of
 * Claude's normal screen shows, so a request or agent output that quotes the dialog does not count.
 * v2.1.x: "Accessing workspace:" / "Quick safety check: Is this a project you created or one you
 * trust?" with the choice "Yes, I trust this folder"; older versions asked "Do you trust the files
 * in this folder?" with "Yes, proceed".
 */
export const TRUST_PROMPT = {
  /** Matched per line. */
  questionLine: [/^Accessing workspace:$/i, /^Quick safety check:/i],
  /** Matched on the joined dialog text, so a wrapped sentence still counts. */
  questionText: [
    /Is this a project you created or one you trust\?/i,
    /Do you trust the files in this folder\?/i,
  ],
  choice: [/^(?:\d+\.\s*)?Yes, I trust this folder$/i, /^(?:\d+\.\s*)?Yes, proceed$/i],
  footer: [/^Enter to confirm · Esc to (?:cancel|exit)$/i],
} as const;

/** Lines of Claude's normal screen: the input box hint and its status line. */
const NORMAL_SCREEN = [
  /\? for shortcuts/i,
  /^(?:>|❯)$/,
  /bypass permissions on|auto mode on|accept edits on/i,
];

/** The horizontal rule Claude draws above the dialog (and around its input box). */
const RULE = /^\s*─{8,}\s*$/;

/** At most this many non-empty lines are read: the dialog is 10 lines wide-open, 18 at 40 columns. */
export const TRUST_TAIL_LINES = 40;

function clean(line: string): string {
  return line
    .replace(/^[\s❯›>│┃║╎|●•*·⏺-]+/u, '')
    .replace(/[\s│┃║╎|]+$/u, '')
    .trim();
}

const matches = (line: string, patterns: readonly RegExp[]) => patterns.some((p) => p.test(line));

/**
 * Whether the bottom of the pane is Claude's folder-trust dialog. The dialog is read as everything
 * below the last horizontal rule (at most `tailLines` non-empty lines), so its height at any window
 * width does not matter.
 */
export function detectTrustPrompt(text: string, tailLines = TRUST_TAIL_LINES): boolean {
  const all = text.split('\n');
  let rule = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (RULE.test(all[i] ?? '')) {
      rule = i;
      break;
    }
  }
  const tail = all
    .slice(rule + 1)
    .filter((l) => l.trim() !== '')
    .slice(-tailLines);
  const lines = tail.map(clean);
  const last = lines[lines.length - 1];
  if (last === undefined || !matches(last, TRUST_PROMPT.footer)) return false;
  if (tail.some((l) => matches(l.trim(), NORMAL_SCREEN))) return false;
  if (!lines.some((l) => matches(l, TRUST_PROMPT.choice))) return false;
  const joined = lines.join(' ').replace(/\s+/g, ' ');
  return (
    lines.some((l) => matches(l, TRUST_PROMPT.questionLine)) || matches(joined, TRUST_PROMPT.questionText)
  );
}

export const TRUST_DONE = 'Done, I trusted it';
export const TRUST_LATER = 'Later';

/**
 * The question the human gets when a session waits at the trust dialog: where it waits and the exact
 * command to reach it. Answering changes nothing by itself; the dialog only goes once someone
 * answers it in the window.
 */
export function trustQuestion(
  sessionId: number,
  tmuxTarget: string,
  folder: string,
  seenAt: Date,
): { text: string; context: string; options: string[]; recommendedOption: string } {
  // Window and time make each launch's report distinct: identical text would be re-attached to the
  // earlier question by the question service, and nothing new would reach the human.
  const when = seenAt.toISOString().slice(0, 16).replace('T', ' ');
  return {
    text:
      `Session ${sessionId} is waiting at Claude's "Do you trust this folder?" prompt for ${folder} ` +
      `(window ${tmuxTarget}, seen ${when} UTC). It does nothing until the prompt is answered.`,
    context:
      `Run \`tmux attach -t ${tmuxTarget}\`, choose "Yes, I trust this folder" if you do, then detach with Ctrl-b d. ` +
      "A git worktree inherits trust from its repo's main checkout: run `claude` once in that checkout " +
      'and accept the prompt there, and later sessions of the repo will not stop here (docs/reference.md, "Folder trust").',
    options: [TRUST_DONE, TRUST_LATER],
    recommendedOption: TRUST_LATER,
  };
}
