import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ValidationError } from '@loop-engineering/core';
import * as z from 'zod';

export const ATTACHMENT_LIMITS = { files: 5, bytes: 5 * 1024 * 1024 } as const;

export const attachment = z.strictObject({
  name: z.string().trim().min(1).max(200),
  /** The file's bytes, base64. */
  data: z
    .string()
    .min(1)
    .max(Math.ceil((ATTACHMENT_LIMITS.bytes * 4) / 3) + 4),
});
export const attachments = z.array(attachment).max(ATTACHMENT_LIMITS.files);
export type Attachment = z.infer<typeof attachment>;

/** A name safe to write as one file: no directories, no leading dots, no odd characters. */
export function safeFileName(name: string, index: number): string {
  const cleaned = basename(name.replace(/\\/g, '/'))
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/^\.+/, '')
    .slice(-100);
  const safe = cleaned === '' ? `file-${index + 1}` : cleaned;
  // OpenCode may not read *.env files: keep an attached one readable.
  return /\.env(\.|$)/i.test(safe) ? `${safe}.txt` : safe;
}

/**
 * Saves the files and returns the request text with their absolute paths appended, so the agent
 * can open them. `root` is the temp dir by default: the one place outside a worktree every agent may
 * read (OpenCode denies other external directories; see agent-config.ts). Each upload gets a folder
 * from mkdtemp: random name, created atomically, mode 0700, so on a shared host no one else can read
 * it or plant files in it first. Files are 0600. A failure removes the folder again.
 */
export function saveAttachments(text: string, files: Attachment[], root = tmpdir()): string {
  if (files.length === 0) return text;
  const decoded = files.map((file) => {
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.length === 0) throw new ValidationError(`"${file.name}" is empty`);
    if (bytes.length > ATTACHMENT_LIMITS.bytes)
      throw new ValidationError(`"${file.name}" is over ${ATTACHMENT_LIMITS.bytes / 1024 / 1024} MB`);
    return bytes;
  });
  const dir = mkdtempSync(join(root, 'loop-upload-'));
  try {
    const paths = files.map((file, i) => {
      const path = join(dir, `${i + 1}-${safeFileName(file.name, i)}`);
      writeFileSync(path, decoded[i]!, { mode: 0o600 });
      return path;
    });
    return `${text}\n\nAttached files (open them with the Read tool):\n${paths.map((p) => `- ${p}`).join('\n')}`;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
