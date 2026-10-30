import { describe, expect, it } from 'vitest';
import { attachProblem, fileLabel, readAttachments } from './attachments';

describe('attachments', () => {
  it('accepts a few small files', () => {
    expect(attachProblem([{ size: 1 }], [{ name: 'a.png', size: 10 }])).toBeNull();
  });
  it('refuses a sixth file, an oversized file and an empty file', () => {
    const five = Array.from({ length: 5 }, () => ({ size: 1 }));
    expect(attachProblem(five, [{ name: 'a', size: 1 }])).toMatch(/at most 5/);
    expect(attachProblem([], [{ name: 'big.png', size: 6 * 1024 * 1024 }])).toMatch(/big\.png.*over 5 MB/);
    expect(attachProblem([], [{ name: 'x', size: 0 }])).toMatch(/empty/);
  });
  it('names a pasted screenshot after its type', () => {
    expect(fileLabel({ name: 'image.png', type: 'image/png' }, 1)).toBe('pasted-image-2.png');
    expect(fileLabel({ name: 'shot.jpg', type: 'image/jpeg' }, 0)).toBe('shot.jpg');
  });
  it('reads files as base64', async () => {
    const out = await readAttachments([new File(['hello'], 'hi.txt', { type: 'text/plain' })]);
    expect(out).toEqual([{ name: 'hi.txt', data: 'aGVsbG8=' }]);
  });
});
