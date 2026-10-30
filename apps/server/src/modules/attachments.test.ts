import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS, safeFileName, saveAttachments, uploadsRoot } from './attachments.js';

const roots: string[] = [];
const root = () => {
  const r = mkdtempSync(join(tmpdir(), 'att-'));
  roots.push(r);
  return r;
};
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

describe('attachments', () => {
  it('returns the text unchanged without files', () => {
    expect(saveAttachments(root(), 'hi', [])).toBe('hi');
  });

  it('saves files and appends their absolute paths to the text', () => {
    const r = root();
    const out = saveAttachments(r, 'Fix this', [
      { name: 'shot.png', data: Buffer.from('PNG!').toString('base64') },
    ]);
    const path = out.split('\n- ')[1]!;
    expect(out.startsWith('Fix this\n\nAttached files')).toBe(true);
    expect(path.startsWith(r)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('PNG!');
  });

  it('never lets a name leave its folder', () => {
    expect(safeFileName('../../etc/passwd', 0)).toBe('passwd');
    expect(safeFileName('..\\..\\x.png', 0)).toBe('x.png');
    expect(safeFileName('...', 2)).toBe('file-3');
    const r = root();
    const out = saveAttachments(r, 't', [{ name: '../../evil.sh', data: 'YQ==' }]);
    expect(out).not.toContain('..');
  });

  it('refuses an oversized or empty file', () => {
    const big = Buffer.alloc(ATTACHMENT_LIMITS.bytes + 1).toString('base64');
    expect(() => saveAttachments(root(), 't', [{ name: 'b', data: big }])).toThrow(/over 5 MB/);
    expect(() => saveAttachments(root(), 't', [{ name: 'e', data: '=' }])).toThrow(/empty/);
  });

  it('keeps uploads next to the database', () => {
    expect(uploadsRoot('/var/loop/loop.db')).toBe('/var/loop/uploads');
    expect(uploadsRoot(':memory:')).toContain('loop-uploads');
  });
});
