/**
 * Claude Code writes every message it takes to its conversation file (`<projects>/<encoded cwd>/<id>.jsonl`)
 * the moment it takes it: a "user" entry when it was idle, a "queue-operation" enqueue (later a
 * "queued_command" attachment) when it was busy. That is the agent's own record, unlike its screen.
 */

/** The texts of the messages recorded in `jsonl` (whole lines only; a partly written last line is skipped). */
export function takenMessages(jsonl: string): string[] {
  const texts: string[] = [];
  for (const raw of jsonl.split('\n')) {
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as {
      type?: unknown;
      operation?: unknown;
      content?: unknown;
      message?: { content?: unknown };
      attachment?: { type?: unknown; prompt?: unknown };
    };
    if (e.type === 'user') {
      const content = e.message?.content;
      if (typeof content === 'string') texts.push(content);
      else if (Array.isArray(content))
        for (const block of content as { type?: unknown; text?: unknown }[])
          if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    } else if (e.type === 'queue-operation' && e.operation === 'enqueue' && typeof e.content === 'string') {
      texts.push(e.content);
    } else if (e.type === 'attachment' && e.attachment?.type === 'queued_command') {
      if (typeof e.attachment.prompt === 'string') texts.push(e.attachment.prompt);
    }
  }
  return texts;
}

const bare = (s: string) => s.replace(/\s+/g, '');

/** `jsonl` records a message carrying `line`. */
export const transcriptHas = (jsonl: string, line: string): boolean =>
  takenMessages(jsonl).some((text) => bare(text).includes(bare(line)));
