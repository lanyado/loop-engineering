/**
 * Claude Code writes the messages it takes to its conversation file (`<projects>/<encoded cwd>/<id>.jsonl`),
 * a fraction of a second after it takes them (after any UserPromptSubmit hooks): a "user" entry when it
 * was idle, a "queue-operation" enqueue (later a "queued_command" attachment) when it was busy. That is
 * the agent's own record, unlike its screen. Only what a human could have typed counts: not meta
 * entries, compaction summaries, task notifications or messages from other agents and channels.
 */

interface Entry {
  type?: unknown;
  operation?: unknown;
  content?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  isCompactSummary?: unknown;
  origin?: { kind?: unknown };
  message?: { content?: unknown };
  attachment?: {
    type?: unknown;
    prompt?: unknown;
    commandMode?: unknown;
    isMeta?: unknown;
    origin?: { kind?: unknown };
  };
}

/** Typed by a human (or the runner, which types like one): no origin, or a human one. */
const typed = (origin: { kind?: unknown } | undefined) => origin === undefined || origin?.kind === 'human';

/** The texts of the messages recorded in `jsonl` (whole lines only; a partly written last line is skipped). */
export function takenMessages(jsonl: string): string[] {
  const taken: string[] = [];
  // Waiting in Claude's queue: taken, unless the queue goes back into the input box (Esc: popAll).
  let queued: string[] = [];
  for (const raw of jsonl.split('\n')) {
    let e: Entry;
    try {
      e = JSON.parse(raw) as Entry;
    } catch {
      continue;
    }
    if (typeof e !== 'object' || e === null || e.isMeta || e.isSidechain || e.isCompactSummary) continue;
    if (e.type === 'user' && typed(e.origin)) {
      const content = e.message?.content;
      if (typeof content === 'string') taken.push(content);
      else if (Array.isArray(content))
        for (const block of content as { type?: unknown; text?: unknown }[])
          if (block?.type === 'text' && typeof block.text === 'string') taken.push(block.text);
    } else if (e.type === 'queue-operation') {
      // Notifications and channel messages are queued as tagged text ("<task-notification>…").
      if (e.operation === 'enqueue' && typeof e.content === 'string' && !e.content.startsWith('<'))
        queued.push(e.content);
      else if (e.operation === 'popAll') queued = [];
    } else if (e.type === 'attachment' && e.attachment?.type === 'queued_command') {
      const a = e.attachment;
      if (a.commandMode === 'prompt' && !a.isMeta && typed(a.origin) && typeof a.prompt === 'string')
        taken.push(a.prompt);
    }
  }
  return [...taken, ...queued];
}

const bare = (s: string) => s.replace(/\s+/g, '');

/** `jsonl` records a message carrying `line`. */
export const transcriptHas = (jsonl: string, line: string): boolean =>
  takenMessages(jsonl).some((text) => bare(text).includes(bare(line)));
