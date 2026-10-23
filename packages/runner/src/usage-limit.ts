const RESETS = String.raw`(?:\s*[·∙•|-]\s*resets?\s.+)?`;

/**
 * Messages Claude Code prints when the account runs out of usage, matched against a whole pane line
 * (after TUI decoration is stripped), so agent output that merely quotes them mid-line does not
 * count. Wording has changed across CLI versions and plans, so this is a plain list: add a pattern
 * when a new message shows up. Per-model limits ("Opus limit reached, now using Sonnet") are left
 * out on purpose: Claude keeps working there.
 */
export const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /^Claude AI usage limit reached\|\d+$/i,
  /^Claude (?:AI )?usage limit reached\.?(?: Your limit (?:will )?resets?(?: at)? .+)?$/i,
  new RegExp(
    String.raw`^You(?:'|’)ve (?:hit|reached) your (?:usage |session |weekly |daily )?limit\.?${RESETS}$`,
    'i',
  ),
  new RegExp(String.raw`^(?:5-hour|five-hour|session|weekly|daily) limit reached\.?${RESETS}$`, 'i'),
  new RegExp(String.raw`^You(?:'|’)re out of (?:extra )?usage\.?${RESETS}$`, 'i'),
];

/** Only the bottom of the pane is checked: older lines may be code or chat that mentions limits. */
export const DEFAULT_TAIL_LINES = 25;

/** Strips the TUI's leading/trailing decoration: result markers, box borders, bullets, prompts. */
function clean(line: string): string {
  return line
    .replace(/^[\s⎿│┃║╎|>●•*·⏺✻-]+/u, '')
    .replace(/[\s│┃║╎|]+$/u, '')
    .trim();
}

/** The first of the last `tailLines` non-empty lines of `text` that is a usage-limit message, or null. */
export function detectUsageLimit(
  text: string,
  patterns: readonly RegExp[] = USAGE_LIMIT_PATTERNS,
  tailLines = DEFAULT_TAIL_LINES,
): string | null {
  const lines = text
    .split('\n')
    .map(clean)
    .filter((l) => l !== '');
  for (const line of lines.slice(-tailLines)) {
    if (patterns.some((p) => p.test(line))) return line;
  }
  return null;
}
