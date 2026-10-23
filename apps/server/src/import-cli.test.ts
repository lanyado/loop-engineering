import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@loop-engineering/core';
import { encodeProjectDir } from '@loop-engineering/history';
import { ensureRouterSession } from '@loop-engineering/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holdsNoPieceOf, SECRET_SAMPLES } from '../../../packages/core/src/test-support/secret-samples.js';
import { runImportCli } from './import-cli.js';

const TOKEN = `ghp_${'Z9y8X7w6V5'.repeat(4)}`;
const line = (type: 'user' | 'assistant', text: string, timestamp: string) =>
  JSON.stringify({ type, timestamp, message: { role: type, content: text } });

describe('import-sessions CLI', () => {
  let root: string;
  let db: string;
  let claudeDir: string;
  let folder: string;
  let out: string[];
  let err: string[];

  const cli = (...argv: string[]) =>
    runImportCli(argv, { env: {}, out: (l) => out.push(l), err: (l) => err.push(l) });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'loop-import-cli-')));
    db = join(root, 'loop.db');
    claudeDir = join(root, 'claude');
    folder = join(root, 'resume');
    mkdirSync(folder);
    const store = openStore({ path: db });
    store.projects.create({ name: 'resume', kind: 'folder', folderPath: folder });
    ensureRouterSession(store);
    store.close();
    const dir = join(claudeDir, 'projects', encodeProjectDir(folder));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '00000000-0000-4000-8000-000000000001.jsonl');
    writeFileSync(
      file,
      [
        line('user', `Tailor my resume, token ${TOKEN}`, '2026-09-01T09:00:00.000Z'),
        line('assistant', 'PRIVATE ASSISTANT REPLY', '2026-09-01T09:20:00.000Z'),
      ].join('\n'),
    );
    const old = new Date('2026-09-02T00:00:00Z');
    utimesSync(file, old, old);
    writeFileSync(join(dir, '00000000-0000-4000-8000-000000000002.jsonl'), '');
    utimesSync(join(dir, '00000000-0000-4000-8000-000000000002.jsonl'), old, old);
    out = [];
    err = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('imports, prints counts and redacted titles only, and imports nothing the second time', async () => {
    expect(await cli('--project', 'resume', '--db', db, '--claude-dir', claudeDir)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('+ 2026-09-01  Tailor my resume, token ***');
    expect(text).toContain('imported 1 of 2 file(s); skipped: already imported 0, empty 1, corrupt 0');
    expect(text).not.toContain('PRIVATE ASSISTANT REPLY');
    expect(text).not.toContain(TOKEN);
    out = [];
    expect(await cli('--project', 'resume', '--db', db, '--claude-dir', claudeDir)).toBe(0);
    expect(out.join('\n')).toContain('imported 0 of 2 file(s); skipped: already imported 1, empty 1');
    const store = openStore({ path: db });
    expect(store.sessions.list({ source: 'import' })).toHaveLength(1);
    store.close();
  });

  it('dry run stores nothing', async () => {
    expect(await cli('--project', 'resume', '--db', db, '--claude-dir', claudeDir, '--dry-run')).toBe(0);
    expect(out.join('\n')).toContain('would import 1 of 2');
    const store = openStore({ path: db });
    expect(store.sessions.list({ source: 'import' })).toEqual([]);
    store.close();
  });

  it('refuses unknown projects (before importing any), the router project, a missing database and bad flags', async () => {
    expect(await cli('--project', 'resume', '--project', 'nope', '--db', db, '--claude-dir', claudeDir)).toBe(
      1,
    );
    expect(err.join('\n')).toBe('No project named "nope". Registered projects: resume');
    expect(await cli('--project', 'Direct input (router)', '--db', db, '--claude-dir', claudeDir)).toBe(1);
    const store = openStore({ path: db });
    expect(store.sessions.list({ source: 'import' })).toEqual([]);
    store.close();

    const missing = join(root, 'missing.db');
    expect(await cli('--project', 'resume', '--db', missing)).toBe(1);
    expect(existsSync(missing)).toBe(false);
    expect(await cli('--db', db)).toBe(2);
    expect(await cli('--project', 'resume', '--bogus')).toBe(2);
    expect(
      await cli('--project', 'resume', '--db', db, '--claude-dir', claudeDir, '--also-dir', '../x'),
    ).toBe(1);
    expect(err.at(-1)).toMatch(/--also-dir/);
    expect(await cli('--help')).toBe(0);
    expect(out.join('\n')).toContain('Usage: npm run import-sessions');
  });

  it('takes --also-dir folder names that start with "-", in both forms, and absolute paths', async () => {
    const wt = join(root, 'resume-wt');
    const wtDir = join(claudeDir, 'projects', encodeProjectDir(wt));
    mkdirSync(wtDir, { recursive: true });
    const file = join(wtDir, '00000000-0000-4000-8000-000000000003.jsonl');
    writeFileSync(file, line('user', 'From the worktree', '2026-09-03T09:00:00.000Z'));
    utimesSync(file, new Date('2026-09-04T00:00:00Z'), new Date('2026-09-04T00:00:00Z'));
    const base = ['--project', 'resume', '--db', db, '--claude-dir', claudeDir, '--dry-run'];
    for (const form of [
      ['--also-dir', encodeProjectDir(wt)],
      [`--also-dir=${encodeProjectDir(wt)}`],
      ['--also-dir', wt],
    ]) {
      out = [];
      expect(await cli(...base, ...form), form.join(' ')).toBe(0);
      expect(out.join('\n')).toContain('From the worktree');
    }
    // An option after --also-dir is still an option, not a folder name.
    expect(await cli('--project', 'resume', '--also-dir', '--dry-run')).toBe(2);
  });

  it('--quiet prints counts only', async () => {
    expect(await cli('--project', 'resume', '--db', db, '--claude-dir', claudeDir, '--quiet')).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('imported 1 of 2 file(s)');
    expect(text).not.toContain('Tailor');
  });

  it('prints one safe line for any failure: no stack, no secret, no multi-line message', async () => {
    const token = SECRET_SAMPLES[0]!.token;
    const code = await runImportCli(['--project', 'resume', '--db', db, '--claude-dir', claudeDir], {
      env: {},
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      importSessions: () => {
        const e = new TypeError(
          `bad line ${token} password=Hunter2!Secret\n{"secret transcript": "PRIVATE"}`,
        );
        return Promise.reject(e);
      },
    });
    expect(code).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toBe('Project resume: import failed: TypeError: bad line *** password=***');
    expect(err[0]).not.toMatch(/ at |PRIVATE|\n/);
    expect(holdsNoPieceOf(err.join('\n'), token)).toBe(true);
  });

  it('never prints a secret of any known shape', async () => {
    const dir = join(claudeDir, 'projects', encodeProjectDir(folder));
    SECRET_SAMPLES.forEach((sample, i) => {
      const file = join(dir, `10000000-0000-4000-8000-${String(i).padStart(12, '0')}.jsonl`);
      writeFileSync(
        file,
        [
          line('user', `${sample.token} is my key`, '2026-09-05T09:00:00.000Z'),
          line('assistant', `Saved ${sample.token}`, '2026-09-05T09:01:00.000Z'),
        ].join('\n'),
      );
      utimesSync(file, new Date('2026-09-06T00:00:00Z'), new Date('2026-09-06T00:00:00Z'));
    });
    expect(await cli('--project', 'resume', '--db', db, '--claude-dir', claudeDir)).toBe(0);
    const text = [...out, ...err].join('\n');
    expect(text).toContain(`imported ${SECRET_SAMPLES.length + 1} of`);
    for (const sample of SECRET_SAMPLES) expect(holdsNoPieceOf(text, sample.token), sample.name).toBe(true);
  });

  it('prints a refusal shared by two projects once, naming both, and still imports the others', async () => {
    const dotted = join(root, 'my.app');
    const dashed = join(root, 'my-app');
    mkdirSync(dotted);
    mkdirSync(dashed);
    const store = openStore({ path: db });
    store.projects.create({ name: 'dotted', kind: 'folder', folderPath: dotted });
    store.projects.create({ name: 'dashed', kind: 'folder', folderPath: dashed });
    store.close();
    const code = await cli(
      ...['--project', 'dotted', '--project', 'dashed', '--project', 'resume'],
      ...['--db', db, '--claude-dir', claudeDir],
    );
    expect(code).toBe(1);
    expect(err).toEqual([
      'Refused: projects "dashed" and "dotted" map to the same Claude folder name (Claude turns every character other than a letter or digit into "-"), so neither is imported from it',
    ]);
    expect(out.join('\n')).toContain('imported 1 of 2 file(s)');
  });
});
