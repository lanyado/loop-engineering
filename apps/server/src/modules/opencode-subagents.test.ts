import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { FakeClock, openStore } from '@loop-engineering/core';
import { describe, expect, it } from 'vitest';
import type { ServerContext } from '../context.js';
import { opencodeDbSource, opencodeSubagentsModule } from './opencode-subagents.js';

const NOW = Date.parse('2026-10-19T09:00:00.000Z');

describe('opencodeDbSource', () => {
  it("reads the child sessions of the folder's conversations, with their model", () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-'));
    const file = join(dir, 'opencode.db');
    const db = new Database(file);
    db.exec(`CREATE TABLE session_v2 (id TEXT, parent_id TEXT, title TEXT, directory TEXT, model TEXT,
      time_created INTEGER, time_updated INTEGER)`);
    const add = db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?)');
    const model = JSON.stringify({ id: 'glm-5.3-flash-free', providerID: 'opencode' });
    add.run('p1', null, 'main', '/wt/a', model, NOW, NOW);
    add.run('c1', 'p1', 'Coin Run', '/wt/a', model, NOW + 1, NOW + 5);
    add.run('p2', null, 'old', '/wt/a', model, NOW - 3_600_000, NOW);
    add.run('c2', 'p2', 'old child', '/wt/a', model, NOW, NOW);
    add.run('c3', 'p9', 'other folder', '/wt/b', model, NOW, NOW);
    db.close();
    try {
      expect(opencodeDbSource(file)('/wt/a', NOW - 60_000)).toEqual([
        { id: 'c1', title: 'Coin Run', model: 'opencode/glm-5.3-flash-free', updatedAt: NOW + 5 },
      ]);
      expect(opencodeDbSource(join(dir, 'missing.db'))('/wt/a', 0)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('opencodeSubagentsModule', () => {
  it('records each child once, running while active and done once idle', () => {
    const clock = new FakeClock('2026-10-19T09:00:00.000Z');
    const store = openStore({ clock });
    const shop = store.projects.create({
      name: 'shop',
      repos: [
        { name: 'web', path: '/Users/me/web', remote: 'git@github.com:me/web.git', defaultBranch: 'main' },
      ],
    });
    const s = store.sessions.create({
      projectId: shop.id,
      title: 'games',
      model: 'opencode/glm',
      provider: 'opencode',
      branch: 'b',
      worktrees: [{ repo: 'web', path: '/wt/games/web' }],
    });
    let updatedAt = NOW;
    const seen: string[] = [];
    const module = opencodeSubagentsModule({
      source: (dir) => {
        seen.push(dir);
        return [{ id: 'c1', title: 'Rocket Race', model: 'opencode/glm', updatedAt }];
      },
    });
    void module.start?.({ store, clock } as unknown as ServerContext);
    try {
      module.sync();
      module.sync();
      expect(store.subagents.list({ sessionId: s.id }).map((x) => [x.title, x.status])).toEqual([
        ['Rocket Race', 'running'],
      ]);
      updatedAt = NOW - 10 * 60_000;
      module.sync();
      expect(store.subagents.list({ sessionId: s.id }).map((x) => x.status)).toEqual(['done']);
      expect(seen.at(-1)).toBe('/wt/games/web');
    } finally {
      void module.stop?.();
      store.close();
    }
  });
});
