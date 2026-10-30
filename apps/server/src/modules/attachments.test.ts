import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS, safeFileName, saveAttachments } from './attachments.js';

const roots: string[] = [];
const root = () => {
  const r = mkdtempSync(join(tmpdir(), 'att-'));
  roots.push(r);
  return r;
};
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

describe('attachments', () => {
  it('returns the text unchanged without files', () => {
    expect(saveAttachments('hi', [], root())).toBe('hi');
  });

  it('saves files and appends their absolute paths to the text', () => {
    const r = root();
    const out = saveAttachments(
      'Fix this',
      [{ name: 'shot.png', data: Buffer.from('PNG!').toString('base64') }],
      r,
    );
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
    const out = saveAttachments('t', [{ name: '../../evil.sh', data: 'YQ==' }], r);
    expect(out).not.toContain('..');
  });

  it('refuses an oversized or empty file', () => {
    const big = Buffer.alloc(ATTACHMENT_LIMITS.bytes + 1).toString('base64');
    expect(() => saveAttachments('t', [{ name: 'b', data: big }], root())).toThrow(/over 5 MB/);
    expect(() => saveAttachments('t', [{ name: 'e', data: '=' }], root())).toThrow(/empty/);
  });

  it('keeps the folder and files private to the server user', () => {
    const r = root();
    const out = saveAttachments('t', [{ name: 'a.png', data: 'YQ==' }], r);
    const path = out.split('\n- ')[1]!;
    expect(statSync(dirname(path)).mode & 0o077).toBe(0);
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it('keeps an attached .env file readable to agents', () => {
    expect(safeFileName('prod.env', 0)).toBe('prod.env.txt');
    expect(safeFileName('.env.local', 0)).toBe('env.local');
    expect(safeFileName('shot.png', 0)).toBe('shot.png');
  });
});
