import { NotFoundError, QUESTION_TIMEOUT_MS } from '@loop-engineering/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUESTION_LIMITS } from './limits.js';
import { REATTACH_WINDOW_MS } from './service.js';
import { harness, MINUTE, newQuestion, type Harness } from './testing/harness.js';

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  vi.restoreAllMocks(); // even when an assertion failed mid-test
  h.close();
});

describe('QuestionService', () => {
  it('creates a question and emits question.created', () => {
    const { question, reused } = h.service.ask(newQuestion(h.session.id));
    expect(reused).toBe(false);
    expect(question.status).toBe('pending');
    expect(h.events).toEqual([{ type: 'question.created', question }]);
  });

  it('reuses an identical pending question from the same asker instead of asking twice', () => {
    const first = h.service.ask(newQuestion(h.session.id)).question;
    const again = h.service.ask(newQuestion(h.session.id));
    expect(again).toEqual({ question: first, reused: true });
    expect(h.service.ask(newQuestion(h.session.id, { text: 'Other?' })).reused).toBe(false);
    const sub = h.store.subagents.create({ sessionId: h.session.id, title: 'x', model: 'm', effort: 'low' });
    expect(h.service.ask({ ...newQuestion(h.session.id), subagentId: sub.id }).reused).toBe(false);
    expect(h.events.filter((e) => e.type === 'question.created')).toHaveLength(3);
  });

  it('re-attaches to an outcome that was never delivered, within 15 minutes of resolving', async () => {
    const first = h.service.ask(newQuestion(h.session.id)).question;
    h.service.answer(first.id, 'Postgres', 'telegram'); // no waiter: the agent was disconnected
    h.clock.advance(REATTACH_WINDOW_MS);
    const again = h.service.ask(newQuestion(h.session.id));
    expect(again).toMatchObject({ reused: true, question: { id: first.id, answer: 'Postgres' } });
    await expect(h.service.wait(first.id)).resolves.toMatchObject({ answer: 'Postgres' });
    expect(h.store.questions.require(first.id).deliveredAt).not.toBeNull();

    // Delivered now, so the same question again is a new one for the human.
    expect(h.service.ask(newQuestion(h.session.id)).reused).toBe(false);
  });

  it('does not re-attach once the window has passed', () => {
    const first = h.service.ask(newQuestion(h.session.id)).question;
    h.service.answer(first.id, 'Postgres', 'telegram');
    h.clock.advance(REATTACH_WINDOW_MS + 1);
    expect(h.service.ask(newQuestion(h.session.id)).reused).toBe(false);
  });

  it('never re-attaches to an outcome a waiter received', async () => {
    const first = h.service.ask(newQuestion(h.session.id)).question;
    const waiting = h.service.wait(first.id);
    h.service.answer(first.id, 'Postgres', 'telegram');
    await waiting;
    expect(h.store.questions.require(first.id).deliveredAt).toBe('2026-10-18T09:00:00.000Z');
    const again = h.service.ask(newQuestion(h.session.id));
    expect(again.reused).toBe(false);
    expect(again.question.id).not.toBe(first.id);
  });

  it('marks a defaulted outcome delivered when its waiter wakes', async () => {
    const { question } = h.service.ask(newQuestion(h.session.id, { timeoutMs: MINUTE }));
    const waiting = h.service.wait(question.id);
    h.clock.advance(MINUTE);
    h.service.expireDue();
    await waiting;
    expect(h.service.ask(newQuestion(h.session.id, { timeoutMs: MINUTE })).reused).toBe(false);
  });

  it('enforces the size caps', () => {
    const base = newQuestion(h.session.id);
    expect(() => h.service.ask({ ...base, text: 'x'.repeat(QUESTION_LIMITS.question + 1) })).toThrow(
      /question must be at most 3000/,
    );
    const many = Array.from({ length: QUESTION_LIMITS.options + 1 }, (_, i) => `o${i}`);
    expect(() => h.service.ask({ ...base, options: many, recommendedOption: 'o0' })).toThrow(
      /at most 10 options/,
    );
    const long = 'o'.repeat(QUESTION_LIMITS.option + 1);
    expect(() => h.service.ask({ ...base, options: [long], recommendedOption: long })).toThrow(/each option/);
    expect(() => h.service.ask({ ...base, context: 'c'.repeat(QUESTION_LIMITS.context + 1) })).toThrow(
      /context must be at most 2000/,
    );
    const { question } = h.service.ask(base);
    expect(() => h.service.answer(question.id, 'a'.repeat(QUESTION_LIMITS.answer + 1), 'telegram')).toThrow(
      /answer must be at most 2000/,
    );
    expect(h.service.answer(question.id, 'a'.repeat(QUESTION_LIMITS.answer), 'telegram').accepted).toBe(true);
  });

  it('emits question.resolved once for the winning answer only', () => {
    const { question } = h.service.ask(newQuestion(h.session.id));
    expect(h.service.answer(question.id, 'Postgres', 'telegram').accepted).toBe(true);
    expect(h.service.answer(question.id, 'SQLite', 'dashboard').accepted).toBe(false);
    const resolved = h.events.filter((e) => e.type === 'question.resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ answer: 'Postgres', answeredVia: 'telegram', defaulted: false });
  });

  it('announces the default when a late answer defaults the question before any sweep', () => {
    const { question } = h.service.ask(newQuestion(h.session.id));
    h.clock.advance(QUESTION_TIMEOUT_MS);
    expect(h.service.answer(question.id, 'Postgres', 'telegram')).toMatchObject({
      accepted: false,
      defaultedNow: true,
    });
    expect(h.service.expireDue()).toEqual([]);
    expect(h.service.answer(question.id, 'Postgres', 'dashboard').defaultedNow).toBe(false);
    const resolved = h.events.filter((e) => e.type === 'question.resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ answer: 'SQLite', answeredVia: 'timeout', defaulted: true });
  });

  it('wakes every waiter exactly once, however the answer and the deadline race', async () => {
    const { question } = h.service.ask(newQuestion(h.session.id));
    const wakes: string[] = [];
    const a = h.service.wait(question.id).then((q) => wakes.push(`a:${q.answer}`));
    const b = h.service.wait(question.id).then((q) => wakes.push(`b:${q.answer}`));
    expect(h.service.waitingCount).toBe(2);

    h.service.answer(question.id, 'Postgres', 'dashboard');
    h.clock.advance(QUESTION_TIMEOUT_MS);
    h.service.expireDue();
    h.service.answer(question.id, 'SQLite', 'telegram');
    await Promise.all([a, b]);

    expect(wakes.sort()).toEqual(['a:Postgres', 'b:Postgres']);
    expect(h.service.waitingCount).toBe(0);
  });

  it('returns at once for a question that is already resolved', async () => {
    const { question } = h.service.ask(newQuestion(h.session.id, { timeoutMs: MINUTE }));
    h.clock.advance(MINUTE);
    h.service.expireDue();
    await expect(h.service.wait(question.id)).resolves.toMatchObject({ status: 'defaulted' });
  });

  it('stops waiting when aborted, leaving the question pending', async () => {
    const { question } = h.service.ask(newQuestion(h.session.id));
    const controller = new AbortController();
    const waiting = h.service.wait(question.id, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow(/abort/i);
    expect(h.service.waitingCount).toBe(0);
    expect(h.store.questions.require(question.id).status).toBe('pending');
    await expect(h.service.wait(question.id, controller.signal)).rejects.toThrow(/abort/i);
  });

  it('rejects waiting on an unknown question', async () => {
    await expect(h.service.wait(999)).rejects.toThrow(NotFoundError);
  });

  it('still wakes waiters and emits question.resolved when marking delivery fails', async () => {
    const { question } = h.service.ask(newQuestion(h.session.id));
    const waiting = h.service.wait(question.id);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(h.store.questions, 'markDelivered').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    const result = h.service.answer(question.id, 'Postgres', 'dashboard');
    expect(result.accepted).toBe(true);
    await expect(waiting).resolves.toMatchObject({ id: question.id, answer: 'Postgres' });
    expect(h.events.at(-1)).toMatchObject({ type: 'question.resolved', answer: 'Postgres' });
    expect(error).toHaveBeenCalledWith(
      `[ask-human] could not mark question ${question.id} delivered:`,
      expect.any(Error),
    );
    // A later wait on the resolved question still returns it.
    await expect(h.service.wait(question.id)).resolves.toMatchObject({ answer: 'Postgres' });
  });
});
