import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { endedPausedText, parsePauseLog, pausedText, resumedText } from './pause-log.js';
import { openStore, type Store } from './store.js';

describe('pause log', () => {
  let store: Store;
  let clock: FakeClock;
  let projectId: number;
  beforeEach(() => {
    clock = new FakeClock('2026-10-01T00:00:00.000Z');
    store = openStore({ clock });
    projectId = store.projects.create({ name: 'shop' }).id;
  });
  afterEach(() => store.close());

  const log = (sessionId: number) =>
    store.history
      .list({ sessionId, kind: 'decision' })
      .map((e) => [e.createdAt.slice(11, 16), e.text])
      .reverse();

  it('records every pause, reason change and resume, but not an end or a re-pause', () => {
    const s = store.sessions.create({ projectId, title: 't', model: 'opus', branch: 'b' });
    clock.set('2026-10-01T01:00:00.000Z');
    store.sessions.update(s.id, { status: 'paused', pauseReason: 'usage_limit' });
    store.sessions.update(s.id, { status: 'paused' }); // already paused for that reason: nothing
    clock.set('2026-10-01T02:00:00.000Z');
    store.sessions.update(s.id, { status: 'paused', pauseReason: 'manual' });
    clock.set('2026-10-01T03:00:00.000Z');
    store.sessions.update(s.id, { status: 'active' });
    store.sessions.update(s.id, { title: 'renamed' }); // no status change: nothing
    clock.set('2026-10-01T04:00:00.000Z');
    store.sessions.update(s.id, { status: 'paused', pauseReason: 'agent_exited' });
    clock.set('2026-10-01T05:00:00.000Z');
    store.sessions.update(s.id, { status: 'ended' });
    store.sessions.update(s.id, { status: 'ended' }); // already ended: nothing
    expect(log(s.id)).toEqual([
      ['01:00', `Session ${s.id} paused (usage_limit).`],
      ['02:00', `Session ${s.id} paused (manual), was usage_limit.`],
      ['03:00', `Session ${s.id} resumed after a pause (manual).`],
      ['04:00', `Session ${s.id} paused (agent_exited).`],
      ['05:00', `Session ${s.id} ended during a pause (agent_exited).`],
    ]);
  });

  it('records a session created paused', () => {
    const s = store.sessions.create({ projectId, title: 't', model: 'opus', branch: 'b', status: 'paused' });
    expect(log(s.id)).toEqual([['00:00', `Session ${s.id} paused (manual).`]]);
  });

  it('creates a paused session and its entry together, or neither', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pause-log-'));
    const path = join(dir, 'loop.db');
    const fileStore = openStore({ path });
    try {
      const p = fileStore.projects.create({ name: 'shop' }).id;
      const raw = new Database(path);
      raw.exec(
        `CREATE TRIGGER no_history BEFORE INSERT ON history_entries BEGIN SELECT RAISE(ABORT, 'no'); END`,
      );
      raw.close();
      expect(() =>
        fileStore.sessions.create({ projectId: p, title: 't', model: 'opus', branch: 'b', status: 'paused' }),
      ).toThrow('no');
      expect(fileStore.sessions.list()).toEqual([]);
    } finally {
      fileStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads its own entries back and nothing else', () => {
    expect(parsePauseLog(pausedText(7, 'usage_limit'))).toEqual({
      kind: 'paused',
      sessionId: 7,
      reason: 'usage_limit',
    });
    expect(parsePauseLog(pausedText(7, 'manual', 'agent_exited'))).toEqual({
      kind: 'paused',
      sessionId: 7,
      reason: 'manual',
    });
    expect(parsePauseLog(resumedText(3, 'agent_exited'))).toEqual({
      kind: 'resumed',
      sessionId: 3,
      reason: 'agent_exited',
    });
    expect(parsePauseLog(endedPausedText(3, 'manual'))).toEqual({
      kind: 'resumed',
      sessionId: 3,
      reason: 'manual',
    });
    expect(parsePauseLog('Session 3 paused (lunch).')).toBeNull();
    expect(parsePauseLog('Session 3 moved from opus to sonnet: limit.')).toBeNull();
  });
});
