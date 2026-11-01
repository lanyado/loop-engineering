import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFs } from './fs.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('nodeFs.readFrom', () => {
  it('reads from a byte offset, and nothing from the end or past it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fs-test-'));
    const path = join(dir, 'c.jsonl');
    writeFileSync(path, 'ab\nשלום\n');
    const size = await nodeFs.size(path);
    expect(size).toBe(12);
    expect(await nodeFs.readFrom(path, 3)).toBe('שלום\n');
    expect(await nodeFs.readFrom(path, size)).toBe('');
    expect(await nodeFs.readFrom(path, size + 50)).toBe('');
    // Inside a character: the broken start belongs to an earlier line, which the parser skips.
    expect((await nodeFs.readFrom(path, 4)).endsWith('ום\n')).toBe(true);
  });
});
