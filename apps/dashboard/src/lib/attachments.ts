import { ATTACHMENT_LIMITS, type AttachmentInput } from './schemas';

/** A file waiting to be sent with a prompt. */
export interface Picked {
  file: File;
  key: number;
}

/** Why `incoming` cannot join `current` (too many, or one too big); null when it fits. */
export function attachProblem(
  current: { size: number }[],
  incoming: { name: string; size: number }[],
): string | null {
  if (current.length + incoming.length > ATTACHMENT_LIMITS.files)
    return `Attach at most ${ATTACHMENT_LIMITS.files} files`;
  const big = incoming.find((f) => f.size > ATTACHMENT_LIMITS.bytes);
  if (big) return `“${big.name}” is over ${ATTACHMENT_LIMITS.bytes / 1024 / 1024} MB`;
  const empty = incoming.find((f) => f.size === 0);
  return empty ? `“${empty.name}” is empty` : null;
}

/** A pasted screenshot has no name of its own ("image.png"): give it one that says what it is. */
export function fileLabel(file: { name: string; type: string }, index: number): string {
  if (file.name && file.name !== 'image.png') return file.name;
  const ext = file.type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
  return `pasted-image-${index + 1}.${ext}`;
}

/** Reads files as base64 for the server action. */
export async function readAttachments(files: File[]): Promise<AttachmentInput[]> {
  return Promise.all(
    files.map(async (file, i) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let o = 0; o < bytes.length; o += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(o, o + 0x8000));
      return { name: fileLabel(file, i), data: btoa(binary) };
    }),
  );
}
