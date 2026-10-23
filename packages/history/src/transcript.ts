import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { maskEdgeFragments, type Worktree } from '@loop-engineering/core';

/** The file operations ingest needs (the real fs; tests use a temp folder). */
export interface TranscriptFs {
  list(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  /** Modification time in ms, or null when the file does not exist. */
  mtimeMs(path: string): Promise<number | null>;
}

export const nodeTranscriptFs: TranscriptFs = {
  list: (path) => fsp.readdir(path),
  readFile: (path) => fsp.readFile(path, 'utf8'),
  async mtimeMs(path) {
    try {
      return (await fsp.stat(path)).mtimeMs;
    } catch {
      return null;
    }
  },
};

/**
 * Claude Code saves each conversation as `<projects dir>/<encoded cwd>/<session id>.jsonl`, where the
 * cwd has every character other than a letter or digit replaced by "-"
 * (`/Users/me/wt/shop` → `-Users-me-wt-shop`). Very long paths are shortened by Claude, which is why
 * findTranscript also searches every folder for the id.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** The folder a session's agent runs in (same rule as the runner). */
export function agentCwd(worktrees: readonly Worktree[]): string | null {
  const [first] = worktrees;
  if (!first) return null;
  return worktrees.length === 1 ? first.path : dirname(first.path);
}

const SAFE_ID = /^[A-Za-z0-9-]+$/;

/** Path of the conversation's JSONL: the cwd's folder first, then any folder. Null when not saved. */
export async function findTranscript(
  fs: TranscriptFs,
  projectsDir: string,
  cwd: string | null,
  agentSessionId: string,
): Promise<string | null> {
  if (!SAFE_ID.test(agentSessionId)) return null;
  const file = `${agentSessionId}.jsonl`;
  if (cwd) {
    const direct = join(projectsDir, encodeProjectDir(cwd), file);
    if ((await fs.mtimeMs(direct)) !== null) return direct;
  }
  const dirs = await fs.list(projectsDir).catch(() => [] as string[]);
  for (const dir of dirs) {
    const path = join(projectsDir, dir, file);
    if ((await fs.mtimeMs(path)) !== null) return path;
  }
  return null;
}

interface Block {
  type?: unknown;
  text?: unknown;
}
interface Record {
  type?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  timestamp?: unknown;
  message?: { role?: unknown; content?: unknown; model?: unknown };
}

/** Harness-injected tags whose content is not what the human or the agent said. */
const NOISE_TAGS = [
  'system-reminder',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
];

/**
 * Removes every <tag>…</tag> of NOISE_TAGS. With indexOf, not a lazy regex: a text full of opening
 * tags with no closing one would make a regex rescan the rest of the text for each of them.
 */
export function stripNoise(text: string): string {
  let out = text;
  for (const tag of NOISE_TAGS) {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    if (!out.includes(open)) continue;
    const parts: string[] = [];
    let at = 0;
    for (;;) {
      const start = out.indexOf(open, at);
      if (start === -1) break;
      const end = out.indexOf(close, start + open.length);
      if (end === -1) break; // no closing tag after this one, so none after any later one either
      parts.push(out.slice(at, start));
      at = end + close.length;
    }
    parts.push(out.slice(at));
    out = parts.join('');
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  // Only text blocks: tool calls, tool results, thinking and images are left out.
  return (content as Block[])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/** One line of a Claude Code JSONL transcript, as far as history cares. */
export type TranscriptLine =
  /** Not JSON (a partly written last line, or a damaged file). */
  | { kind: 'corrupt' }
  /** Valid, but not a user or assistant message of the main conversation (summaries, snapshots, meta). */
  | { kind: 'other' }
  | {
      kind: 'message';
      role: 'user' | 'assistant';
      /** What the human or the agent said, harness noise removed; empty for tool calls and results. */
      text: string;
      /** ISO time of the message, when the line has one. */
      timestamp: string | null;
      /** The model of an assistant message, when given. */
      model: string | null;
    };

export function parseTranscriptLine(line: string): TranscriptLine {
  let record: Record;
  try {
    record = JSON.parse(line) as Record;
  } catch {
    return { kind: 'corrupt' };
  }
  if (typeof record !== 'object' || record === null) return { kind: 'corrupt' };
  if (record.type !== 'user' && record.type !== 'assistant') return { kind: 'other' };
  if (record.isMeta === true || record.isSidechain === true) return { kind: 'other' };
  const text = stripNoise(textOf(record.message?.content));
  const timestamp =
    typeof record.timestamp === 'string' && !Number.isNaN(Date.parse(record.timestamp))
      ? record.timestamp
      : null;
  const model = typeof record.message?.model === 'string' ? record.message.model : null;
  return { kind: 'message', role: record.type, text: text.trim(), timestamp, model };
}

/** A message longer than this keeps only its first and last MESSAGE_KEEP characters. */
export const MESSAGE_MAX = 1_000_000;
export const MESSAGE_KEEP = 256 * 1024;

/**
 * Redacts one message. A huge one (a pasted file) is first cut to its start and end, at whitespace
 * where possible so no token is split, then each piece is redacted and whatever could be half a
 * token at the cut is masked. That keeps time and memory bounded whatever a message holds.
 */
export function redactMessage(text: string, redact: (text: string) => string): string {
  if (text.length <= MESSAGE_MAX) return redact(text);
  const cutAt = (from: number, to: number, last: boolean) => {
    for (let i = last ? to - 1 : from; last ? i >= from : i < to; i += last ? -1 : 1) {
      if (/\s/.test(text[i]!)) return i;
    }
    return last ? to : from;
  };
  const headEnd = cutAt(MESSAGE_KEEP - 4096, MESSAGE_KEEP, true);
  const tailStart = cutAt(text.length - MESSAGE_KEEP, text.length - MESSAGE_KEEP + 4096, false);
  const head = maskEdgeFragments(redact(text.slice(0, headEnd)), 'end');
  const tail = maskEdgeFragments(redact(text.slice(tailStart)), 'start');
  return `${head}\n… (${tailStart - headEnd} characters of this message left out) …\n${tail}`;
}

export interface CompactOptions {
  /** Cap on the result. Default 60 000 characters. */
  maxChars?: number;
  /**
   * Applied to each whole message before it is kept or cut (secret redaction), so a cut can never
   * leave part of a secret behind.
   */
  redact?: (text: string) => string;
}

/**
 * Builds the compact text one message at a time, holding at most about `maxChars` (plus one
 * message), so a transcript of any size can be streamed through it. Over the cap, the start (the
 * request) and the end (where it got to) are kept.
 */
export class TranscriptCompactor {
  private readonly maxChars: number;
  private readonly redact: ((text: string) => string) | undefined;
  private full = '';
  private total = 0;
  private overflow = false;
  private head = '';
  private tail: string[] = [];
  private tailLength = 0;

  constructor(options: CompactOptions = {}) {
    this.maxChars = options.maxChars ?? 60_000;
    this.redact = options.redact;
  }

  add(role: 'user' | 'assistant', said: string): void {
    const text = said && this.redact ? redactMessage(said, this.redact) : said;
    if (!text) return;
    const chunk = `${this.total > 0 ? '\n\n' : ''}${role === 'user' ? 'User' : 'Assistant'}: ${text}`;
    this.total += chunk.length;
    const headLength = Math.floor(this.maxChars * 0.3);
    const tailLength = this.maxChars - headLength;
    if (!this.overflow) {
      this.full += chunk;
      if (this.full.length <= this.maxChars) return;
      this.overflow = true;
      this.head = this.full.slice(0, headLength);
      this.tail = [this.full];
      this.tailLength = this.full.length;
      this.full = '';
    } else {
      this.tail.push(chunk);
      this.tailLength += chunk.length;
    }
    // Keep just enough chunks to cut the last tailLength characters from.
    while (this.tail.length > 1 && this.tailLength - (this.tail[0]?.length ?? 0) >= tailLength) {
      this.tailLength -= this.tail.shift()?.length ?? 0;
    }
  }

  /** "User: …" / "Assistant: …" paragraphs; empty when nothing was said. */
  result(): string {
    if (!this.overflow) return this.full;
    const tailLength = this.maxChars - Math.floor(this.maxChars * 0.3);
    // Whatever the cut went through is masked if it could be half a token.
    const head = maskEdgeFragments(this.head, 'end');
    const tail = maskEdgeFragments(this.tail.join('').slice(-tailLength), 'start');
    return `${head}\n\n… (${this.total - this.maxChars} characters left out) …\n\n${tail}`;
  }
}

/** User and assistant text from a Claude Code JSONL transcript (see TranscriptCompactor). */
export function compactTranscript(jsonl: string, options: CompactOptions = {}): string {
  const compactor = new TranscriptCompactor(options);
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseTranscriptLine(line);
    if (parsed.kind === 'message') compactor.add(parsed.role, parsed.text);
  }
  return compactor.result();
}
