import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate } from './migrations.js';
import { openStore } from './store.js';

const LATEST = MIGRATIONS.at(-1)?.version ?? 0;

describe('migrations', () => {
  it('numbers migrations 1..N with no gaps or duplicates', () => {
    // migrate() skips every version at or below user_version, so a gap filled later would never run.
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it('applies every migration once and records user_version', () => {
    const db = new Database(':memory:');
    expect(migrate(db)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)?.version);
    expect(migrate(db)).toEqual([]);
    db.close();
  });

  it('applies only newer migrations', () => {
    const db = new Database(':memory:');
    migrate(db);
    const next = {
      version: LATEST + 1,
      name: 'add column',
      sql: 'ALTER TABLE projects ADD COLUMN note TEXT',
    };
    expect(migrate(db, [...MIGRATIONS, next])).toEqual([LATEST + 1]);
    const columns = db.prepare<[], { name: string }>('PRAGMA table_info(projects)').all();
    expect(columns.map((c) => c.name)).toContain('note');
    db.close();
  });

  it('rolls back a failing migration', () => {
    const db = new Database(':memory:');
    migrate(db);
    const bad = { version: LATEST + 1, name: 'bad', sql: 'CREATE TABLE ok (x); CREATE TABLE broken (' };
    expect(() => migrate(db, [...MIGRATIONS, bad])).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").get()).toBeUndefined();
    db.close();
  });

  it('upgrades a version 1 database in place, keeping its rows', () => {
    const db = new Database(':memory:');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version === 1),
    );
    db.exec(`INSERT INTO projects (name, created_at) VALUES ('p', '2026-01-01T00:00:00.000Z')`);
    expect(migrate(db)).toEqual(MIGRATIONS.filter((m) => m.version > 1).map((m) => m.version));
    const columns = db.prepare<[], { name: string }>('PRAGMA table_info(questions)').all();
    expect(columns.map((c) => c.name)).toEqual(expect.arrayContaining(['context', 'delivered_at']));
    expect(db.prepare('SELECT name FROM projects').all()).toEqual([{ name: 'p' }]);
    db.close();
  });

  it('migration 4 rebuilds sessions without losing rows, child rows or the id sequence', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version === 1),
    );
    db.exec(`
      INSERT INTO projects (name, created_at) VALUES ('p', 't');
      INSERT INTO sessions (project_id, title, model, branch, created_at, status, pause_reason)
        VALUES (1, 'a', 'opus', 'b', 't', 'paused', 'travel'), (1, 'gone', 'opus', 'b2', 't', 'active', NULL);
      INSERT INTO questions (session_id, text, options, recommended_option, created_at, deadline)
        VALUES (1, 'q', '["x"]', 'x', 't', 't');
      DELETE FROM sessions WHERE id = 2;
    `);
    expect(
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version <= 4),
      ),
    ).toEqual([2, 3, 4]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare('SELECT id, title, pause_reason, effort FROM sessions').all()).toEqual([
      { id: 1, title: 'a', pause_reason: 'travel', effort: null },
    ]);
    expect(db.prepare('SELECT session_id FROM questions').all()).toEqual([{ session_id: 1 }]);
    db.exec(
      `INSERT INTO sessions (project_id, title, model, branch, created_at, status, pause_reason)
       VALUES (1, 'new', 'opus', 'b3', 't', 'paused', 'agent_exited')`,
    );
    expect(db.prepare(`SELECT id FROM sessions WHERE title = 'new'`).get()).toEqual({ id: 3 });
    // The questions -> sessions foreign key still cascades.
    db.exec('DELETE FROM sessions WHERE id = 1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM questions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT permission_mode FROM projects').get()).toEqual({ permission_mode: 'auto' });
    expect(db.prepare('SELECT session_model FROM settings').get()).toEqual({ session_model: 'opus' });
    db.close();
  });

  it('migration 5 makes requests.project_id nullable, keeping rows, PR links and the id sequence', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 5),
    );
    db.exec(`
      INSERT INTO projects (name, created_at) VALUES ('p', 't');
      INSERT INTO requests (project_id, text, source, created_at) VALUES (1, 'a', 'telegram', 't'), (1, 'gone', 'dashboard', 't');
      INSERT INTO pull_requests (project_id, request_id, repo, number, url, created_at, updated_at)
        VALUES (1, 1, 'web', 1, 'u', 't', 't');
      DELETE FROM requests WHERE id = 2;
    `);
    expect(migrate(db)).toEqual(MIGRATIONS.filter((m) => m.version >= 5).map((m) => m.version));
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare('SELECT id, project_id, text FROM requests').all()).toEqual([
      { id: 1, project_id: 1, text: 'a' },
    ]);
    expect(db.prepare('SELECT request_id FROM pull_requests').get()).toEqual({ request_id: 1 });
    db.exec(`INSERT INTO requests (text, source, created_at) VALUES ('unrouted', 'telegram', 't')`);
    expect(db.prepare(`SELECT id FROM requests WHERE text = 'unrouted'`).get()).toEqual({ id: 3 });
    expect(() =>
      db.exec(`INSERT INTO requests (session_id, text, source, created_at) VALUES (1, 'x', 'telegram', 't')`),
    ).toThrow(/CHECK/);
    // pull_requests -> requests still sets null on delete.
    db.exec('DELETE FROM requests WHERE id = 1');
    expect(db.prepare('SELECT request_id FROM pull_requests').get()).toEqual({ request_id: null });
    db.close();
  });

  it('migration 8 turns existing projects into git projects and ties kind to folder_path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-mig8-'));
    try {
      const path = join(dir, 'loop.db');
      const db = new Database(path);
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version < 8),
      );
      db.exec(`INSERT INTO projects (name, repos, auto_merge, created_at)
               VALUES ('shop', '[{"name":"web","path":"/src/web","remote":"r","defaultBranch":"main"}]', 1, 't')`);
      db.close();
      // An existing database file opened by new code migrates in place.
      const store = openStore({ path });
      const shop = store.projects.getByName('shop');
      expect(shop).toMatchObject({ kind: 'git', folderPath: null, autoMerge: true });
      expect(shop?.repos.map((r) => r.name)).toEqual(['web']);
      const folder = store.projects.create({ name: 'resume', kind: 'folder', folderPath: '/home/me/resume' });
      expect(store.projects.require(folder.id)).toMatchObject({
        kind: 'folder',
        folderPath: '/home/me/resume',
      });
      store.close();
      const raw = new Database(path);
      expect(raw.pragma('user_version', { simple: true })).toBe(LATEST);
      expect(() =>
        raw.exec(`INSERT INTO projects (name, kind, created_at) VALUES ('x', 'folder', 't')`),
      ).toThrow(/CHECK/);
      expect(() =>
        raw.exec(`INSERT INTO projects (name, kind, folder_path, created_at) VALUES ('x', 'git', '/a', 't')`),
      ).toThrow(/CHECK/);
      expect(() =>
        raw.exec(
          `INSERT INTO projects (name, kind, folder_path, created_at) VALUES ('x', 'folder', 'rel', 't')`,
        ),
      ).toThrow(/CHECK/);
      expect(() =>
        raw.exec(
          `INSERT INTO projects (name, kind, folder_path, created_at) VALUES ('x', 'folder', '/home/me/resume', 't')`,
        ),
      ).toThrow(/UNIQUE/);
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migration 9 marks existing sessions runner-launched; imported ones stay ended and unique', () => {
    const db = new Database(':memory:');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 9),
    );
    db.exec(`INSERT INTO projects (name, created_at) VALUES ('shop', 't')`);
    db.exec(`INSERT INTO sessions (project_id, title, model, branch, agent_session_id, created_at)
             VALUES (1, 'live', 'opus', 'b', 'abc', 't')`);
    expect(
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version <= 9),
      ),
    ).toEqual([9]);
    expect(db.prepare('SELECT source FROM sessions').all()).toEqual([{ source: 'runner' }]);
    const insert = (status: string, source: string, agent = 'abc') =>
      db.exec(`INSERT INTO sessions (project_id, title, status, model, branch, agent_session_id, source, created_at)
               VALUES (1, 'past', '${status}', 'opus', '', '${agent}', '${source}', 't')`);
    // A runner session with the same conversation id does not block the import (the importer checks that).
    insert('ended', 'import');
    expect(() => insert('ended', 'import')).toThrow(/UNIQUE/);
    expect(() => insert('active', 'import', 'def')).toThrow(/CHECK/);
    expect(() => insert('ended', 'cloud', 'def')).toThrow(/CHECK/);
    db.close();
  });

  it('migration 10 adds requests.target_session_id, cleared when that session is deleted', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 10),
    );
    db.exec(`INSERT INTO projects (name, created_at) VALUES ('shop', 't')`);
    db.exec(
      `INSERT INTO requests (project_id, text, source, created_at) VALUES (1, 'old', 'dashboard', 't')`,
    );
    expect(
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version <= 10),
      ),
    ).toEqual([10]);
    expect(db.prepare('SELECT target_session_id FROM requests').all()).toEqual([{ target_session_id: null }]);
    db.exec(
      `INSERT INTO sessions (project_id, title, model, branch, created_at) VALUES (1, 's', 'opus', 'b', 't')`,
    );
    db.exec(`UPDATE requests SET target_session_id = 1`);
    db.exec(`DELETE FROM sessions`);
    expect(db.prepare('SELECT target_session_id FROM requests').all()).toEqual([{ target_session_id: null }]);
    db.close();
  });

  it('migration 17 lets guardian runs be skipped and keeps the runs it had', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 17),
    );
    db.exec(`
      INSERT INTO projects (name, created_at) VALUES ('p', 't');
      INSERT INTO guardian_runs (project_id, repo, trigger, status, summary, created_at)
        VALUES (1, 'web', 'daily', 'passed', 'all checks passed', 't');
    `);
    const skip = `INSERT INTO guardian_runs (project_id, repo, trigger, status, created_at)
                  VALUES (1, 'web', 'daily', 'skipped', 't')`;
    expect(() => db.exec(skip)).toThrow(/CHECK/);
    expect(
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version <= 17),
      ),
    ).toEqual([17]);
    db.exec(skip);
    expect(db.prepare('SELECT id, status, summary FROM guardian_runs ORDER BY id').all()).toEqual([
      { id: 1, status: 'passed', summary: 'all checks passed' },
      { id: 2, status: 'skipped', summary: '' },
    ]);
    db.close();
  });

  it('migration 18 allows the check stage and keeps PRs, their metrics and their links', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 18),
    );
    db.exec(`
      INSERT INTO projects (name, created_at) VALUES ('p', 't');
      INSERT INTO pull_requests (project_id, repo, number, url, stage, created_at, updated_at, loop_state)
        VALUES (1, 'web', 7, 'u7', 'review', 't', 't', '{"reviewedSha":"abc"}'),
               (1, 'web', 8, 'u8', 'merge', 't', 't', '{}');
      UPDATE pull_requests SET reverted_by_pr_id = 2 WHERE id = 1;
      INSERT INTO loop_metrics (pr_id) VALUES (1);
    `);
    const check = `INSERT INTO pull_requests (project_id, repo, number, url, stage, created_at, updated_at)
                   VALUES (1, 'web', 9, 'u9', 'check', 't', 't')`;
    expect(() => db.exec(check)).toThrow(/CHECK/);
    expect(
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version <= 18),
      ),
    ).toEqual([18]);
    db.exec(check);
    expect(
      db.prepare('SELECT id, stage, reverted_by_pr_id, loop_state FROM pull_requests ORDER BY id').all(),
    ).toEqual([
      { id: 1, stage: 'review', reverted_by_pr_id: 2, loop_state: '{"reviewedSha":"abc"}' },
      { id: 2, stage: 'merge', reverted_by_pr_id: null, loop_state: '{}' },
      { id: 3, stage: 'check', reverted_by_pr_id: null, loop_state: '{}' },
    ]);
    expect(db.prepare('SELECT pr_id FROM loop_metrics').all()).toEqual([{ pr_id: 1 }]);
    expect(() => db.exec(`UPDATE pull_requests SET stage = 'nope' WHERE id = 1`)).toThrow(/CHECK/);
    db.close();
  });

  it('migration 20 lets requests and answers be by email, keeping requests, questions and their links', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 20),
    );
    db.exec(`
      INSERT INTO projects (name, created_at) VALUES ('p', 't');
      INSERT INTO sessions (project_id, title, model, branch, created_at) VALUES (1, 's', 'opus', 'b', 't');
      INSERT INTO requests (project_id, session_id, text, source, created_at) VALUES (1, 1, 'root', 'telegram', 't');
      INSERT INTO requests (project_id, text, source, created_at, parent_request_id) VALUES (1, 'part', 'dashboard', 't', 1);
      INSERT INTO questions (session_id, text, options, recommended_option, status, answer, answered_via, created_at, deadline, request_id)
        VALUES (1, 'q', '["a"]', 'a', 'answered', 'a', 'telegram', 't', 't', 1);
      INSERT INTO pull_requests (project_id, repo, number, url, request_id, created_at, updated_at) VALUES (1, 'web', 7, 'u', 2, 't', 't');
    `);
    expect(
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version <= 20),
      ),
    ).toEqual([20]);
    db.exec(`INSERT INTO requests (text, source, created_at) VALUES ('mailed', 'email', 't');
             UPDATE questions SET answered_via = 'email' WHERE id = 1;`);
    expect(db.prepare('SELECT id, source, parent_request_id FROM requests ORDER BY id').all()).toEqual([
      { id: 1, source: 'telegram', parent_request_id: null },
      { id: 2, source: 'dashboard', parent_request_id: 1 },
      { id: 3, source: 'email', parent_request_id: null },
    ]);
    expect(db.prepare('SELECT request_id, answered_via FROM questions').all()).toEqual([
      { request_id: 1, answered_via: 'email' },
    ]);
    expect(db.prepare('SELECT request_id FROM pull_requests').all()).toEqual([{ request_id: 2 }]);
    expect(() => db.exec(`INSERT INTO requests (text, source, created_at) VALUES ('x', 'fax', 't')`)).toThrow(
      /CHECK/,
    );
    // Deleting a request still clears what pointed at it.
    db.exec('DELETE FROM requests WHERE id = 1');
    expect(db.prepare('SELECT request_id FROM questions').all()).toEqual([{ request_id: null }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM requests').get()).toEqual({ n: 1 });
    db.close();
  });

  it('migration 21 gives existing sessions the standard rigor and refuses unknown levels', () => {
    const db = new Database(':memory:');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 21),
    );
    db.exec(`
      INSERT INTO projects (name, created_at) VALUES ('p', 't');
      INSERT INTO sessions (project_id, title, model, branch, created_at) VALUES (1, 'live', 'opus', 'b', 't');
      INSERT INTO sessions (project_id, title, status, model, branch, created_at, ended_at)
        VALUES (1, 'done', 'ended', 'opus', 'b2', 't', 't');
    `);
    expect(
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version <= 21),
      ),
    ).toEqual([21]);
    expect(db.prepare('SELECT id, title, status, rigor FROM sessions ORDER BY id').all()).toEqual([
      { id: 1, title: 'live', status: 'active', rigor: 'standard' },
      { id: 2, title: 'done', status: 'ended', rigor: 'standard' },
    ]);
    db.exec(`UPDATE sessions SET rigor = 'thorough' WHERE id = 1`);
    expect(() => db.exec(`UPDATE sessions SET rigor = 'yolo' WHERE id = 1`)).toThrow(/CHECK/);
    db.close();
  });

  it('migration 22 gives every session an empty plan', () => {
    const db = new Database(':memory:');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 22),
    );
    db.exec(`
      INSERT INTO projects (name, created_at) VALUES ('p', 't');
      INSERT INTO sessions (project_id, title, model, branch, created_at) VALUES (1, 'live', 'opus', 'b', 't');
    `);
    expect(
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version <= 22),
      ),
    ).toEqual([22]);
    expect(db.prepare('SELECT title, plan, planned_at FROM sessions').all()).toEqual([
      { title: 'live', plan: null, planned_at: null },
    ]);
    db.close();
  });

  it('migration 23 keeps a level the human set (not Standard) theirs, and refuses unknown sources', () => {
    const db = new Database(':memory:');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 23),
    );
    db.exec(`
      INSERT INTO projects (name, created_at) VALUES ('p', 't');
      INSERT INTO sessions (project_id, title, model, branch, rigor, created_at)
        VALUES (1, 'live', 'opus', 'b', 'light', 't');
      INSERT INTO sessions (project_id, title, model, branch, created_at) VALUES (1, 'plain', 'opus', 'b2', 't');
    `);
    expect(
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version <= 23),
      ),
    ).toEqual([23]);
    expect(db.prepare('SELECT rigor, rigor_source, rigor_reason FROM sessions ORDER BY id').all()).toEqual([
      { rigor: 'light', rigor_source: 'human', rigor_reason: null },
      { rigor: 'standard', rigor_source: 'default', rigor_reason: null },
    ]);
    db.exec(`UPDATE sessions SET rigor_source = 'planner', rigor_reason = 'tiny' WHERE id = 1`);
    expect(() => db.exec(`UPDATE sessions SET rigor_source = 'bot' WHERE id = 1`)).toThrow(/CHECK/);
    db.close();
  });

  it('migration 24 adds the per-agent models and their reason, empty for existing sessions', () => {
    const db = new Database(':memory:');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 24),
    );
    db.exec(`
      INSERT INTO projects (name, created_at) VALUES ('p', 't');
      INSERT INTO sessions (project_id, title, model, branch, created_at) VALUES (1, 'live', 'opus', 'b', 't');
    `);
    expect(
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version <= 24),
      ),
    ).toEqual([24]);
    expect(db.prepare('SELECT models, models_reason FROM sessions').all()).toEqual([
      { models: null, models_reason: null },
    ]);
    db.close();
  });

  it('migration 25 drops the direct-input mark and permission mode, keeping the rest of each project', () => {
    const db = new Database(':memory:');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 25),
    );
    db.exec(`
      INSERT INTO projects (name, auto_merge, marked_for_direct_input, permission_mode, created_at)
        VALUES ('p', 1, 1, 'plan', 't');
      INSERT INTO sessions (project_id, title, model, branch, created_at) VALUES (1, 'live', 'opus', 'b', 't');
    `);
    expect(
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version <= 25),
      ),
    ).toEqual([25]);
    const columns = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).not.toContain('marked_for_direct_input');
    expect(columns).not.toContain('permission_mode');
    expect(db.prepare('SELECT name, auto_merge FROM projects').all()).toEqual([{ name: 'p', auto_merge: 1 }]);
    expect(db.prepare('SELECT title FROM sessions').all()).toEqual([{ title: 'live' }]);
    db.close();
  });

  it('migration 15 drops cloud and calendar/travel data: old pause reasons become manual, nothing is deleted', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 15),
    );
    db.exec(`
      INSERT INTO projects (name, created_at) VALUES ('p', 't');
      INSERT INTO sessions (project_id, title, model, branch, created_at, status, pause_reason, runtime, cloud_session_url)
        VALUES (1, 'call', 'opus', 'b1', 't', 'paused', 'video_call', 'local', NULL),
               (1, 'trip', 'opus', 'b2', 't', 'paused', 'travel', 'cloud', 'https://claude.ai/code/session_x'),
               (1, 'limit', 'opus', 'b3', 't', 'paused', 'usage_limit', 'local', NULL),
               (1, 'exited', 'opus', 'b4', 't', 'paused', 'agent_exited', 'local', NULL),
               (1, 'mine', 'opus', 'b5', 't', 'paused', 'manual', 'local', NULL),
               (1, 'live', 'opus', 'b6', 't', 'active', NULL, 'local', NULL),
               (1, 'gone', 'opus', 'b7', 't', 'active', NULL, 'local', NULL);
      INSERT INTO sessions (project_id, title, model, branch, created_at, status, agent_session_id, source)
        VALUES (1, 'past', 'opus', '', 't', 'ended', 'conv', 'import');
      INSERT INTO subagents (session_id, title, model, effort, created_at) VALUES (1, 's', 'opus', 'low', 't');
      INSERT INTO questions (session_id, subagent_id, text, options, recommended_option, created_at, deadline)
        VALUES (1, 1, 'q', '["x"]', 'x', 't', 't');
      INSERT INTO requests (project_id, session_id, target_session_id, text, source, created_at)
        VALUES (1, 2, 3, 'r', 'telegram', 't');
      INSERT INTO pull_requests (project_id, session_id, repo, number, url, created_at, updated_at)
        VALUES (1, 4, 'web', 1, 'u', 't', 't');
      INSERT INTO history_entries (project_id, session_id, kind, text, created_at)
        VALUES (1, 5, 'decision', 'kept', 't');
      UPDATE settings SET router_session_id = 6;
      DELETE FROM sessions WHERE id = 7;
    `);
    expect(
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version <= 15),
      ),
    ).toEqual([15]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    expect(db.prepare('SELECT id, title, status, pause_reason FROM sessions ORDER BY id').all()).toEqual([
      { id: 1, title: 'call', status: 'paused', pause_reason: 'manual' },
      { id: 2, title: 'trip', status: 'paused', pause_reason: 'manual' },
      { id: 3, title: 'limit', status: 'paused', pause_reason: 'usage_limit' },
      { id: 4, title: 'exited', status: 'paused', pause_reason: 'agent_exited' },
      { id: 5, title: 'mine', status: 'paused', pause_reason: 'manual' },
      { id: 6, title: 'live', status: 'active', pause_reason: null },
      { id: 8, title: 'past', status: 'ended', pause_reason: null },
    ]);
    expect(db.prepare('SELECT source, agent_session_id FROM sessions WHERE id = 8').get()).toEqual({
      source: 'import',
      agent_session_id: 'conv',
    });
    const columns = (table: string) =>
      db
        .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
    expect(columns('sessions')).not.toEqual(expect.arrayContaining(['runtime']));
    expect(columns('sessions')).not.toEqual(expect.arrayContaining(['cloud_session_url']));
    expect(columns('sessions')).toEqual(expect.arrayContaining(['effort', 'source', 'agent_session_id']));
    expect(columns('settings')).not.toContain('video_call_pause');
    expect(db.prepare('SELECT claude_enabled, session_model FROM settings').get()).toEqual({
      claude_enabled: 1,
      session_model: 'opus',
    });

    // Rows of the tables that point at sessions survived the rebuild.
    expect(db.prepare('SELECT COUNT(*) AS n FROM subagents').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT session_id FROM questions').get()).toEqual({ session_id: 1 });
    expect(db.prepare('SELECT session_id, target_session_id FROM requests').get()).toEqual({
      session_id: 2,
      target_session_id: 3,
    });
    expect(db.prepare('SELECT session_id FROM pull_requests').get()).toEqual({ session_id: 4 });
    expect(db.prepare('SELECT session_id FROM history_entries').get()).toEqual({ session_id: 5 });
    expect(db.prepare('SELECT router_session_id FROM settings').get()).toEqual({ router_session_id: 6 });

    // The id sequence keeps its high-water mark, and the old reasons and the paused invariant are enforced.
    const insert = (status: string, reason: string | null, agent: string | null = null) =>
      db.exec(`INSERT INTO sessions (project_id, title, model, branch, created_at, status, pause_reason, agent_session_id)
               VALUES (1, 'n', 'opus', 'b', 't', '${status}', ${reason ? `'${reason}'` : 'NULL'}, ${agent ? `'${agent}'` : 'NULL'})`);
    insert('active', null);
    expect(db.prepare(`SELECT MAX(id) AS id FROM sessions`).get()).toEqual({ id: 9 });
    expect(() => insert('paused', 'video_call')).toThrow(/CHECK/);
    expect(() => insert('paused', 'travel')).toThrow(/CHECK/);
    expect(() => insert('paused', null)).toThrow(/CHECK/);
    expect(() => insert('active', 'manual')).toThrow(/CHECK/);
    // The cascades and set-null rules still work through the new sessions table.
    db.exec('DELETE FROM sessions WHERE id = 1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM questions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM subagents').get()).toEqual({ n: 0 });
    db.exec('DELETE FROM sessions WHERE id = 2');
    expect(db.prepare('SELECT session_id FROM requests').get()).toEqual({ session_id: null });
    // The import uniqueness index is back.
    expect(() =>
      db.exec(`INSERT INTO sessions (project_id, title, model, branch, created_at, status, agent_session_id, source)
               VALUES (1, 'dup', 'opus', '', 't', 'ended', 'conv', 'import')`),
    ).toThrow(/UNIQUE/);
    db.close();
  });

  it('refuses a database created by newer code', () => {
    const db = new Database(':memory:');
    db.pragma('user_version = 99');
    expect(() => migrate(db)).toThrow(/newer than this code/);
    db.close();
  });

  it('openStore migrates and seeds settings', () => {
    const store = openStore();
    expect(store.settings.get().fallbackModel).toBe('opencode/glm-5.3-flash-free');
    store.close();
  });

  it('reopens a file database without re-running migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-store-'));
    try {
      const path = join(dir, 'loop.db');
      const first = openStore({ path });
      first.projects.create({ name: 'kept' });
      first.close();
      const second = openStore({ path });
      expect(second.projects.getByName('kept')?.name).toBe('kept');
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
