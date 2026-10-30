import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
  return cleaned === '' ? `file-${index + 1}` : cleaned;
}

/** Where uploads live: next to the database, or the temp dir for an in-memory one. */
export function uploadsRoot(dbPath: string): string {
  return dbPath !== ':memory:' && dbPath.startsWith('/')
    ? join(dirname(dbPath), 'uploads')
    : join(tmpdir(), 'loop-uploads');
}

/**
 * Saves the files and returns the request text with their absolute paths appended, so the agent
 * can open them. Each upload gets its own random folder: names never collide or escape it.
 */
export function saveAttachments(root: string, text: string, files: Attachment[]): string {
  if (files.length === 0) return text;
  const dir = join(root, randomBytes(8).toString('hex'));
  mkdirSync(dir, { recursive: true });
  const paths = files.map((file, i) => {
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.length === 0) throw new ValidationError(`"${file.name}" is empty`);
    if (bytes.length > ATTACHMENT_LIMITS.bytes)
      throw new ValidationError(`"${file.name}" is over ${ATTACHMENT_LIMITS.bytes / 1024 / 1024} MB`);
    const path = join(dir, `${i + 1}-${safeFileName(file.name, i)}`);
    writeFileSync(path, bytes);
    return path;
  });
  return `${text}\n\nAttached files (open them with the Read tool):\n${paths.map((p) => `- ${p}`).join('\n')}`;
}
