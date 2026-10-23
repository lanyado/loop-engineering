import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fromRoot, loadRootEnv, REPO_ROOT } from './env.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.LOOP_ENV_TEST_A;
  delete process.env.LOOP_ENV_TEST_B;
});

describe('env', () => {
  it('finds the repo root from the module location, not the working directory', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { name: string };
    expect(pkg.name).toBe('loop-engineering');
  });

  it('loads <root>/.env without overriding variables already set', () => {
    const root = mkdtempSync(join(tmpdir(), 'loop-env-'));
    dirs.push(root);
    expect(loadRootEnv(root)).toBe(false);
    writeFileSync(join(root, '.env'), 'LOOP_ENV_TEST_A=from-file\nLOOP_ENV_TEST_B=from-file\n');
    process.env.LOOP_ENV_TEST_B = 'from-shell';
    expect(loadRootEnv(root)).toBe(true);
    expect(process.env.LOOP_ENV_TEST_A).toBe('from-file');
    expect(process.env.LOOP_ENV_TEST_B).toBe('from-shell');
  });

  it('resolves relative paths against the root', () => {
    expect(fromRoot('./data/loop.db', '/srv/loop')).toBe('/srv/loop/data/loop.db');
    expect(fromRoot('/var/loop.db', '/srv/loop')).toBe('/var/loop.db');
    expect(fromRoot(':memory:', '/srv/loop')).toBe(':memory:');
  });
});
