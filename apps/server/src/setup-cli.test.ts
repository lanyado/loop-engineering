import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fillEnv, runSetup, type SetupIo } from './setup-cli.js';

describe('fillEnv', () => {
  it('fills empty and missing keys and keeps values already set', () => {
    const { text, filled } = fillEnv('A=\nB=kept\n# C= in a comment\n', { A: '1', B: '2', C: '3' });
    expect(text).toBe('A=1\nB=kept\n# C= in a comment\nC=3\n');
    expect(filled).toEqual(['A', 'C']);
  });

  it('treats a whitespace-only value as empty', () => {
    expect(fillEnv('A=   \n', { A: 'x' }).text).toBe('A=x\n');
  });

  it('reads the file the way Node does', () => {
    // export and spaces: set, so kept.
    expect(fillEnv('export A=kept\nB = kept\n', { A: 'x', B: 'y' }).filled).toEqual([]);
    // Empty to Node: quoted empty, a comment, and a later empty duplicate (the last line counts).
    expect(fillEnv('A=""\n', { A: 'x' }).text).toBe('A=x\n');
    expect(fillEnv('A= # note\n', { A: 'x' }).text).toBe('A=x\n');
    expect(fillEnv('A=old\nA=\n', { A: 'x' }).text).toBe('A=old\nA=x\n');
  });

  it('writes a value literally, even with $ in it', () => {
    expect(fillEnv('A=\n', { A: "$&$'" }).text).toBe("A=$&$'\n");
  });
});

describe('npm run setup', () => {
  let root: string;
  let home: string;
  let out: string[];
  let n: number;
  const io = (over: Partial<SetupIo> = {}): SetupIo => ({
    root,
    home,
    nodeVersion: '20.19.0',
    onPath: () => true,
    randomToken: () => `token${++n}`.padEnd(32, 'x'),
    out: (l) => out.push(l),
    ...over,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'loop-setup-'));
    home = join(root, 'home');
    writeFileSync(
      join(root, '.env.example'),
      '# example\nDASHBOARD_TOKEN=\nMCP_TOKEN=\nWORKTREES_ROOT=\nSERVER_PORT=8787\n',
    );
    out = [];
    n = 0;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates .env from the example with two different tokens and a worktrees folder', () => {
    expect(runSetup(io())).toBe(0);
    const env = readFileSync(join(root, '.env'), 'utf8');
    expect(env).toContain('# example\n');
    expect(env).toContain(`DASHBOARD_TOKEN=${'token1'.padEnd(32, 'x')}\n`);
    expect(env).toContain(`MCP_TOKEN=${'token2'.padEnd(32, 'x')}\n`);
    expect(env).toContain(`WORKTREES_ROOT=${join(home, 'loop-worktrees')}\n`);
    expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, 'loop-worktrees'))).toBe(true);
    expect(out).toContain('  1. npm start  (server + dashboard at http://127.0.0.1:3737)');
  });

  it('never replaces values on a second run', () => {
    runSetup(io());
    const first = readFileSync(join(root, '.env'), 'utf8');
    expect(runSetup(io())).toBe(0);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(first);
    expect(out).toContain('✓ .env already set up (nothing changed)');
  });

  it('makes an existing .env private (a hand-copied .env.example is usually 0644)', () => {
    writeFileSync(join(root, '.env'), 'DASHBOARD_TOKEN=\nMCP_TOKEN=\nWORKTREES_ROOT=\n');
    chmodSync(join(root, '.env'), 0o644);
    runSetup(io());
    expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600);
  });

  it('creates the WORKTREES_ROOT you set instead of the default', () => {
    const mine = join(root, 'my-worktrees');
    writeFileSync(join(root, '.env'), `DASHBOARD_TOKEN=\nMCP_TOKEN=\nWORKTREES_ROOT=${mine}\n`);
    runSetup(io());
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(join(home, 'loop-worktrees'))).toBe(false);
  });

  it('exits 1 naming a missing required tool, but still writes .env', () => {
    expect(runSetup(io({ onPath: (c) => c !== 'tmux' && c !== 'opencode' }))).toBe(1);
    expect(out.some((l) => l.startsWith('✗ tmux not found'))).toBe(true);
    expect(out.some((l) => l.startsWith('– opencode not found'))).toBe(true);
    expect(out.at(-1)).toBe('Install tmux, then run `npm run setup` again.');
    expect(existsSync(join(root, '.env'))).toBe(true);
  });

  it('refuses a Node older than 20.19 before touching anything', () => {
    expect(runSetup(io({ nodeVersion: '20.18.1' }))).toBe(1);
    expect(existsSync(join(root, '.env'))).toBe(false);
  });
});
