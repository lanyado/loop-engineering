import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QUESTION_TIMEOUT_MS } from '@loop-engineering/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, MINUTE, newQuestion, type Harness } from './testing/harness.js';

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.close());

const resolvedIds = (events: Harness['events']) =>
  events.flatMap((e) => (e.type === 'question.resolved' ? [e.question.id] : []));

describe('DeadlineSweeper', () => {
  it('defaults a question at its deadline, not before, and wakes its waiter once', async () => {
    h.sweeper.start();
    const { question } = h.service.ask(newQuestion(h.session.id));
    const waiting = h.service.wait(question.id);

    h.timers.advance(QUESTION_TIMEOUT_MS - 1);
    expect(h.store.questions.require(question.id).status).toBe('pending');
    h.timers.advance(1);
    await expect(waiting).resolves.toMatchObject({ status: 'defaulted', answer: 'SQLite' });

    const resolved = h.events.filter((e) => e.type === 'question.resolved');
    expect(resolved).toEqual([
      expect.objectContaining({ answer: 'SQLite', answeredVia: 'timeout', defaulted: true }),
    ]);
    h.timers.advance(QUESTION_TIMEOUT_MS);
    expect(resolvedIds(h.events)).toEqual([question.id]);
  });

  it('re-aims at a sooner deadline when a new question arrives', () => {
    h.sweeper.start();
    const slow = h.service.ask(newQuestion(h.session.id, { timeoutMs: 30 * MINUTE })).question;
    const fast = h.service.ask(newQuestion(h.session.id, { text: 'fast?', timeoutMs: 2 * MINUTE })).question;
    h.timers.advance(2 * MINUTE);
    expect(resolvedIds(h.events)).toEqual([fast.id]);
    h.timers.advance(28 * MINUTE);
    expect(resolvedIds(h.events)).toEqual([fast.id, slow.id]);
    expect(h.timers.pending).toBe(0);
  });

  it('does not re-announce a question a human answered before the deadline', () => {
    h.sweeper.start();
    const { question } = h.service.ask(newQuestion(h.session.id));
    h.service.answer(question.id, 'Postgres', 'dashboard');
    h.timers.advance(QUESTION_TIMEOUT_MS * 2);
    expect(h.events.filter((e) => e.type === 'question.resolved')).toHaveLength(1);
  });

  it('catches up after the clock jumps (sleep) thanks to the capped wait', () => {
    h.sweeper.start();
    const { question } = h.service.ask(newQuestion(h.session.id));
    h.clock.advance(QUESTION_TIMEOUT_MS + MINUTE); // no timers fire while "asleep"
    h.timers.advance(0);
    expect(resolvedIds(h.events)).toEqual([question.id]);
  });

  it('defaults questions that came due while it was stopped as soon as it starts', () => {
    const { question } = h.service.ask(newQuestion(h.session.id));
    h.clock.advance(QUESTION_TIMEOUT_MS);
    expect(resolvedIds(h.events)).toEqual([]);
    h.sweeper.start();
    expect(resolvedIds(h.events)).toEqual([question.id]);
  });

  it('stop() cancels its timer and stops listening', () => {
    h.sweeper.start();
    h.service.ask(newQuestion(h.session.id));
    expect(h.timers.pending).toBe(1);
    h.sweeper.stop();
    expect(h.timers.pending).toBe(0);
    h.service.ask(newQuestion(h.session.id, { text: 'again?' }));
    expect(h.timers.pending).toBe(0);
  });
});

describe('restart', () => {
  it('a new server process defaults questions the old one left pending, on time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-human-'));
    const path = join(dir, 'loop.db');
    try {
      const before = harness(path);
      before.sweeper.start();
      const { question } = before.service.ask(newQuestion(before.session.id));
      before.timers.advance(5 * MINUTE);
      before.close(); // the process dies; the question is only in SQLite now

      const after = harness(path);
      after.clock.set(before.clock.now());
      after.sweeper.start();
      expect(after.store.questions.require(question.id).status).toBe('pending');
      after.timers.advance(10 * MINUTE);
      expect(after.events).toEqual([
        expect.objectContaining({ type: 'question.resolved', defaulted: true, answer: 'SQLite' }),
      ]);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an agent that re-asks after a restart re-attaches to its pending question', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-human-'));
    const path = join(dir, 'loop.db');
    try {
      const before = harness(path);
      const { question } = before.service.ask(newQuestion(before.session.id));
      before.close();

      const after = harness(path);
      after.clock.set(before.clock.now());
      after.sweeper.start();
      const again = after.service.ask(newQuestion(after.session.id));
      expect(again).toMatchObject({ reused: true, question: { id: question.id } });
      const waiting = after.service.wait(question.id);
      after.service.answer(question.id, 'Postgres', 'telegram');
      await expect(waiting).resolves.toMatchObject({ answer: 'Postgres' });
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
