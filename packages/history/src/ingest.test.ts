import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, openStore, type Store } from '@loop-engineering/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TranscriptIngester } from './ingest.js';
import { compactTranscript, encodeProjectDir } from './transcript.js';

const FIXTURE = readFileSync(new URL('./fixtures/transcript.jsonl', import.meta.url), 'utf8');
const AGENT_ID = '00000000-0000-4000-8000-000000000001';
const CWD = '/wt/shop/add-login-abc/web';

describe('compactTranscript', () => {
  it('keeps user and assistant text only', () => {
    expect(compactTranscript(FIXTURE)).toBe(
      [
        'User: Add a login page with Google sign-in. Use the existing session cookie.',
        "Assistant: I'll reuse the passport-google-oauth20 strategy rather than writing OAuth by hand.",
        'Assistant: Decision: sessions stay in the cookie store; the redirect URI is /auth/google/callback.',
        'User: Looks good, also add a logout button.',
      ].join('\n\n'),
    );
  });

  it('caps the size, keeping the start and the end', () => {
    const lines = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `message number ${i} ${'x'.repeat(50)}` },
      }),
    );
    const out = compactTranscript(lines.join('\n'), { maxChars: 2000 });
    expect(out.length).toBeLessThan(2100);
    expect(out).toContain('message number 0 ');
    expect(out).toContain('message number 199 ');
    expect(out).toMatch(/characters left out/);
  });

  it('encodes the cwd the way Claude names its project folders', () => {
    expect(encodeProjectDir('/Users/me/.claude/wt/shop_web')).toBe('-Users-me--claude-wt-shop-web');
  });
});

describe('TranscriptIngester', () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;
  let projectId: number;
  let ingester: TranscriptIngester;

  const writeTranscript = (folder: string, content = FIXTURE, mtime = new Date('2026-10-18T09:30:00Z')) => {
    mkdirSync(join(dir, folder), { recursive: true });
    const path = join(dir, folder, `${AGENT_ID}.jsonl`);
    writeFileSync(path, content);
    utimesSync(path, mtime, mtime);
  };
  const session = (status: 'active' | 'paused' | 'ended') =>
    store.sessions.create({
      projectId,
      title: 'Add a login page',
      model: 'opus',
      branch: 'loop/add-login-abc',
      status,
      agentSessionId: AGENT_ID,
      worktrees: [{ repo: 'web', path: CWD }],
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-projects-'));
    clock = new FakeClock('2026-10-18T10:00:00Z');
    store = openStore({ clock });
    projectId = store.projects.create({
      name: 'shop',
      repos: [{ name: 'web', path: '/src/web', remote: 'r', defaultBranch: 'main' }],
    }).id;
    ingester = new TranscriptIngester(store, { projectsDir: dir, log: () => undefined });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores a paused session's transcript from its cwd folder as one searchable entry", async () => {
    const s = session('paused');
    writeTranscript(encodeProjectDir(CWD));
    expect(await ingester.sweep()).toBe(1);
    const [entry] = store.history.list({ sessionId: s.id, kind: 'transcript' });
    expect(entry?.text).toMatch(
      /^Session \d+ "Add a login page" \(branch loop\/add-login-abc, paused\)\n\nUser: Add a login page/,
    );
    expect(entry?.text).not.toMatch(/TOOL OUTPUT|SIDECHAIN|API BLOB|private reasoning|Injected context/);
    expect(store.history.search('passport oauth20', { projectId }).map((h) => h.id)).toEqual([entry!.id]);
  });

  it('finds the transcript in any folder (Claude shortens very long paths) and skips active sessions', async () => {
    const active = session('active');
    writeTranscript('-wt-shop-add-lo-1a2b3c');
    expect(await ingester.sweep()).toBe(0);
    store.sessions.end(active.id);
    expect(await ingester.sweep()).toBe(1);
  });

  it('replaces the stored transcript only when the file changed', async () => {
    const s = session('paused');
    writeTranscript(encodeProjectDir(CWD));
    await ingester.sweep();
    const first = store.history.list({ sessionId: s.id, kind: 'transcript' });
    expect(await ingester.sweep()).toBe(0); // unchanged

    clock.set('2026-10-18T12:00:00Z');
    const more = `${FIXTURE}\n${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Logout button added.' }] } })}\n`;
    writeTranscript(encodeProjectDir(CWD), more, new Date('2026-10-18T11:00:00Z'));
    expect(await ingester.sweep()).toBe(1);
    const second = store.history.list({ sessionId: s.id, kind: 'transcript' });
    expect(second).toHaveLength(1);
    expect(second[0]!.id).not.toBe(first[0]!.id);
    expect(second[0]!.text).toContain('Logout button added.');
  });

  it('does not look at an ended session again once its transcript is stored', async () => {
    const s = session('ended');
    writeTranscript(encodeProjectDir(CWD));
    expect(await ingester.sweep()).toBe(1);
    let stats = 0;
    const counting = new TranscriptIngester(store, {
      projectsDir: dir,
      log: () => undefined,
      fs: {
        list: () => Promise.resolve([]),
        readFile: () => Promise.resolve(''),
        mtimeMs: () => {
          stats++;
          return Promise.resolve(null);
        },
      },
    });
    expect(await counting.sweep()).toBe(0);
    expect(stats).toBe(0);
    expect(store.history.list({ sessionId: s.id, kind: 'transcript' })).toHaveLength(1);
  });

  it('redacts token shapes, project env values and server secrets before storing', async () => {
    const envPath = join(dir, 'web.env');
    writeFileSync(envPath, 'STRIPE_KEY="rk_live_projectvalue42"\n');
    store.projects.update(projectId, { envFiles: [{ repo: 'web', source: envPath, target: '.env.local' }] });
    const s = session('paused');
    const line = (text: string) =>
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      });
    writeTranscript(
      encodeProjectDir(CWD),
      [
        line('Set GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 in CI'),
        line('Stripe key rk_live_projectvalue42 works; server secret server-secret-0001 too'),
      ].join('\n'),
    );
    const redacting = new TranscriptIngester(store, {
      projectsDir: dir,
      secrets: ['server-secret-0001'],
      log: () => undefined,
    });
    await redacting.sweep();
    const text = store.history.list({ sessionId: s.id, kind: 'transcript' })[0]!.text;
    expect(text).toContain('Set GITHUB_TOKEN=*** in CI');
    expect(text).toContain('Stripe key *** works; server secret *** too');
    for (const secret of ['ghp_', 'rk_live_projectvalue42', 'server-secret-0001'])
      expect(text).not.toContain(secret);
  });

  it('keeps decision entries and skips sessions without a saved conversation', async () => {
    const s = session('paused');
    store.history.add({ projectId, sessionId: s.id, kind: 'decision', text: 'Switched to opencode' });
    expect(await ingester.sweep()).toBe(0);
    writeTranscript(encodeProjectDir(CWD));
    expect(await ingester.ingestSession(s.id)).not.toBeNull();
    expect(
      store.history
        .list({ sessionId: s.id })
        .map((e) => e.kind)
        .sort(),
    ).toEqual(['decision', 'transcript']);
  });
});
