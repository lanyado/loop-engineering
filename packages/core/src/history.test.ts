import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { migrate } from './migrations.js';
import { toFtsQuery } from './repos/history.js';
import { openStore, type Store } from './store.js';
import type { Project, Session } from './types.js';

let store: Store;
let shop: Project;
let blog: Project;
let session: Session;

beforeEach(() => {
  store = openStore({ clock: new FakeClock('2026-10-18T09:00:00.000Z') });
  shop = store.projects.create({ name: 'shop' });
  blog = store.projects.create({ name: 'blog' });
  session = store.sessions.create({ projectId: shop.id, title: 's', model: 'm', branch: 'b' });
  return () => store.close();
});

describe('history', () => {
  it('adds, gets, lists and deletes entries', () => {
    const a = store.history.add({
      projectId: shop.id,
      sessionId: session.id,
      kind: 'transcript',
      text: 'hello',
    });
    const b = store.history.add({ projectId: shop.id, kind: 'decision', text: 'use SQLite' });
    expect(a).toEqual({
      id: a.id,
      projectId: shop.id,
      sessionId: session.id,
      kind: 'transcript',
      text: 'hello',
      createdAt: '2026-10-18T09:00:00.000Z',
    });
    expect(store.history.get(b.id)?.sessionId).toBeNull();
    expect(store.history.list({ projectId: shop.id }).map((e) => e.id)).toEqual([b.id, a.id]);
    expect(store.history.list({ kind: 'decision' })).toEqual([b]);
    expect(store.history.list({ limit: 1 })).toEqual([b]);
    expect(store.history.delete(a.id)).toBe(true);
    expect(store.history.search('hello')).toEqual([]);
  });

  it('full-text searches with stemming, best match first', () => {
    store.history.add({
      projectId: shop.id,
      kind: 'transcript',
      text: 'We talked about the payment page layout.',
    });
    const decision = store.history.add({
      projectId: shop.id,
      sessionId: session.id,
      kind: 'decision',
      text: 'Decided: payments go through Stripe; payment retries happen nightly.',
    });
    store.history.add({ projectId: shop.id, kind: 'transcript', text: 'Unrelated chat about fonts.' });

    const hits = store.history.search('payments');
    expect(hits).toHaveLength(2);
    expect(hits[0]?.id).toBe(decision.id);
    expect(hits[0]?.snippet).toContain('[payments]');
    expect(hits[0]?.rank).toBeLessThanOrEqual(hits[1]?.rank ?? 0);

    expect(store.history.search('stripe payment').map((h) => h.id)).toEqual([decision.id]);
    expect(store.history.search('payment', { kind: 'transcript' })).toHaveLength(1);
    expect(store.history.search('payment', { sessionId: session.id })).toHaveLength(1);
    expect(store.history.search('payment', { limit: 1 })).toHaveLength(1);
  });

  it('scopes search to a project', () => {
    store.history.add({ projectId: shop.id, kind: 'decision', text: 'deploy on Vercel' });
    store.history.add({ projectId: blog.id, kind: 'decision', text: 'deploy on Netlify' });
    expect(store.history.search('deploy', { projectId: blog.id }).map((h) => h.text)).toEqual([
      'deploy on Netlify',
    ]);
    expect(store.history.search('deploy')).toHaveLength(2);
  });

  it('treats user input as words, not FTS syntax', () => {
    store.history.add({ projectId: shop.id, kind: 'transcript', text: "don't break the read-only NOT mode" });
    expect(toFtsQuery(`don't "read-only" NOT (`)).toBe('"don" "t" "read" "only" "NOT"');
    expect(store.history.search(`don't "read-only" NOT (`)).toHaveLength(1);
    expect(store.history.search('  ?! ')).toEqual([]);
  });

  it('passes raw FTS5 queries through when asked', () => {
    store.history.add({ projectId: shop.id, kind: 'transcript', text: 'migration to postgres' });
    store.history.add({ projectId: shop.id, kind: 'transcript', text: 'migration to sqlite' });
    expect(store.history.search('migrat* NOT postgres', { raw: true }).map((h) => h.text)).toEqual([
      'migration to sqlite',
    ]);
  });

  it('keeps the FTS index in sync when text is updated in place', () => {
    // There is no update API yet; check the schema trigger directly so a future one stays indexed.
    const db = new Database(':memory:');
    migrate(db);
    db.prepare("INSERT INTO projects (name, created_at) VALUES ('p', 'now')").run();
    db.prepare(
      "INSERT INTO history_entries (project_id, kind, text, created_at) VALUES (1, 'decision', 'old wording', 'now')",
    ).run();
    db.prepare("UPDATE history_entries SET text = 'new wording' WHERE id = 1").run();
    const match = (q: string) => db.prepare('SELECT rowid FROM history_fts WHERE history_fts MATCH ?').all(q);
    expect(match('old')).toEqual([]);
    expect(match('new')).toEqual([{ rowid: 1 }]);
    db.close();
  });

  it('removes FTS rows when a project delete cascades to its history', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    db.prepare("INSERT INTO projects (name, created_at) VALUES ('p', 'now')").run();
    db.prepare(
      "INSERT INTO history_entries (project_id, kind, text, created_at) VALUES (1, 'decision', 'use sqlite', 'now')",
    ).run();
    const docs = () =>
      db.prepare<[], { n: number }>('SELECT count(*) AS n FROM history_fts_docsize').get()?.n;
    expect(docs()).toBe(1);
    db.prepare('DELETE FROM projects WHERE id = 1').run();
    expect(docs()).toBe(0);
    expect(() =>
      db.prepare("INSERT INTO history_fts (history_fts) VALUES ('integrity-check')").run(),
    ).not.toThrow();
    db.close();
  });
});
