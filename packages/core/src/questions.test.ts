import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { NotFoundError, ValidationError } from './errors.js';
import { openStore, type Store } from './store.js';
import { QUESTION_TIMEOUT_MS, type Session } from './types.js';

const MINUTE = 60_000;
let clock: FakeClock;
let store: Store;
let session: Session;

beforeEach(() => {
  clock = new FakeClock('2026-10-18T09:00:00.000Z');
  store = openStore({ clock });
  const project = store.projects.create({ name: 'p' });
  session = store.sessions.create({ projectId: project.id, title: 's', model: 'opus', branch: 'b' });
  return () => store.close();
});

const ask = (extra: { timeoutMs?: number; text?: string } = {}) =>
  store.questions.create({
    sessionId: session.id,
    text: extra.text ?? 'Which database?',
    options: ['SQLite', 'Postgres'],
    recommendedOption: 'SQLite',
    ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
  });

describe('questions', () => {
  it('creates a pending question with a 15 minute deadline', () => {
    const q = ask();
    expect(QUESTION_TIMEOUT_MS).toBe(15 * MINUTE);
    expect(q).toEqual({
      id: q.id,
      sessionId: session.id,
      subagentId: null,
      text: 'Which database?',
      context: null,
      options: ['SQLite', 'Postgres'],
      recommendedOption: 'SQLite',
      status: 'pending',
      answer: null,
      answeredVia: null,
      createdAt: '2026-10-18T09:00:00.000Z',
      deadline: '2026-10-18T09:15:00.000Z',
      answeredAt: null,
      deliveredAt: null,
      requestId: null,
    });
  });

  it('links a routing question to its request, cleared when the request is deleted', () => {
    expect(ask().requestId).toBeNull();
    const request = store.requests.create({ text: 'route me', source: 'telegram' });
    const linked = store.questions.create({
      sessionId: session.id,
      text: 'Where?',
      options: ['a', 'b'],
      recommendedOption: 'a',
      requestId: request.id,
    });
    expect(linked.requestId).toBe(request.id);
    expect(store.questions.list({ requestId: request.id }).map((q) => q.id)).toEqual([linked.id]);
    expect(() =>
      store.questions.create({
        sessionId: session.id,
        text: 'x',
        options: ['a'],
        recommendedOption: 'a',
        requestId: 999,
      }),
    ).toThrow(/FOREIGN KEY/);
  });

  it('links to a subagent of the same session only', () => {
    const sub = store.subagents.create({ sessionId: session.id, title: 'x', model: 'm', effort: 'low' });
    const q = store.questions.create({
      sessionId: session.id,
      subagentId: sub.id,
      text: 't',
      options: ['a'],
      recommendedOption: 'a',
    });
    expect(q.subagentId).toBe(sub.id);

    const otherSession = store.sessions.create({
      projectId: session.projectId,
      title: 'o',
      model: 'm',
      branch: 'o',
    });
    expect(() =>
      store.questions.create({
        sessionId: otherSession.id,
        subagentId: sub.id,
        text: 't',
        options: ['a'],
        recommendedOption: 'a',
      }),
    ).toThrow(/does not belong/);
  });

  it('validates options', () => {
    const base = { sessionId: session.id, text: 'q' };
    expect(() => store.questions.create({ ...base, options: [], recommendedOption: 'a' })).toThrow(
      ValidationError,
    );
    expect(() => store.questions.create({ ...base, options: ['a', 'a'], recommendedOption: 'a' })).toThrow(
      /unique/,
    );
    expect(() => store.questions.create({ ...base, options: ['a'], recommendedOption: 'b' })).toThrow(
      /one of the options/,
    );
    expect(() =>
      store.questions.create({ ...base, options: ['a'], recommendedOption: 'a', timeoutMs: 0 }),
    ).toThrow(/positive/);
  });

  it('keeps only the first answer', () => {
    const q = ask();
    clock.advance(2 * MINUTE);
    const first = store.questions.answer(q.id, 'Postgres', 'telegram');
    expect(first.accepted).toBe(true);
    expect(first.defaultedNow).toBe(false);
    expect(first.question).toMatchObject({
      status: 'answered',
      answer: 'Postgres',
      answeredVia: 'telegram',
      answeredAt: '2026-10-18T09:02:00.000Z',
    });

    const second = store.questions.answer(q.id, 'SQLite', 'dashboard');
    expect(second.accepted).toBe(false);
    expect(second.defaultedNow).toBe(false);
    expect(second.question.answer).toBe('Postgres');
    expect(second.question.answeredVia).toBe('telegram');

    expect(() => store.questions.answer(999, 'x', 'dashboard')).toThrow(NotFoundError);
    expect(() => store.questions.answer(q.id, '  ', 'dashboard')).toThrow(ValidationError);
  });

  it('accepts free-text answers that are not one of the options', () => {
    const q = ask();
    expect(store.questions.answer(q.id, 'Neither, use DuckDB', 'telegram').question.answer).toBe(
      'Neither, use DuckDB',
    );
  });

  it('rejects "timeout" as a human channel at runtime', () => {
    const q = ask();
    expect(() => store.questions.answer(q.id, 'Postgres', 'timeout' as 'telegram')).toThrow(ValidationError);
    expect(store.questions.get(q.id)?.status).toBe('pending');
  });

  it('rejects an answer after the deadline even before any sweep, and defaults the question', () => {
    const q = ask();
    clock.advance(QUESTION_TIMEOUT_MS);
    const late = store.questions.answer(q.id, 'Postgres', 'telegram');
    expect(late.accepted).toBe(false);
    expect(late.defaultedNow).toBe(true);
    expect(late.question).toMatchObject({
      status: 'defaulted',
      answer: 'SQLite',
      answeredVia: 'timeout',
      answeredAt: '2026-10-18T09:15:00.000Z',
    });
    expect(store.questions.expireDue()).toEqual([]);

    // A second late answer finds it already defaulted: not this call's default to announce.
    const again = store.questions.answer(q.id, 'Postgres', 'dashboard');
    expect(again).toMatchObject({ accepted: false, defaultedNow: false });
    expect(again.question.answeredAt).toBe('2026-10-18T09:15:00.000Z');
  });

  it('records delivery once, and only for resolved questions', () => {
    const q = ask();
    expect(store.questions.markDelivered(q.id)).toBe(false);
    clock.advance(MINUTE);
    store.questions.answer(q.id, 'Postgres', 'telegram');
    clock.advance(MINUTE);
    expect(store.questions.markDelivered(q.id)).toBe(true);
    expect(store.questions.markDelivered(q.id)).toBe(false);
    expect(store.questions.get(q.id)?.deliveredAt).toBe('2026-10-18T09:02:00.000Z');
  });

  it('stores optional context, treating blank context as none', () => {
    const withContext = store.questions.create({
      sessionId: session.id,
      text: 'Which database?',
      context: 'The app is single-user and runs on one Mac.',
      options: ['SQLite', 'Postgres'],
      recommendedOption: 'SQLite',
    });
    expect(store.questions.get(withContext.id)?.context).toBe('The app is single-user and runs on one Mac.');
    const blank = store.questions.create({
      sessionId: session.id,
      text: 'q',
      context: '  ',
      options: ['a'],
      recommendedOption: 'a',
    });
    expect(blank.context).toBeNull();
  });

  it('accepts an answer one millisecond before the deadline', () => {
    const q = ask();
    clock.advance(QUESTION_TIMEOUT_MS - 1);
    expect(store.questions.answer(q.id, 'Postgres', 'dashboard').accepted).toBe(true);
  });

  it('lists pending questions by deadline and finds the next one', () => {
    expect(store.questions.nextDeadline()).toBeNull();
    const slow = ask({ timeoutMs: 30 * MINUTE });
    const fast = ask({ timeoutMs: 5 * MINUTE });
    const answered = ask();
    store.questions.answer(answered.id, 'SQLite', 'dashboard');

    expect(store.questions.listPending().map((q) => q.id)).toEqual([fast.id, slow.id]);
    expect(store.questions.nextDeadline()).toBe('2026-10-18T09:05:00.000Z');
    expect(store.questions.list({ status: 'answered' }).map((q) => q.id)).toEqual([answered.id]);
    expect(store.questions.list({ sessionId: session.id })).toHaveLength(3);
  });

  it('finds due questions at the exact deadline, not before', () => {
    const q = ask();
    clock.advance(QUESTION_TIMEOUT_MS - 1);
    expect(store.questions.listDue()).toEqual([]);
    clock.advance(1);
    expect(store.questions.listDue().map((d) => d.id)).toEqual([q.id]);
    expect(store.questions.listDue(new Date('2026-10-18T08:00:00.000Z'))).toEqual([]);
  });

  it('defaults due questions to the recommended option', () => {
    const due = ask({ timeoutMs: 5 * MINUTE });
    const later = ask({ timeoutMs: 20 * MINUTE });
    const answered = ask({ timeoutMs: 1 * MINUTE });
    store.questions.answer(answered.id, 'Postgres', 'telegram');

    clock.advance(16 * MINUTE);
    const expired = store.questions.expireDue();
    expect(expired.map((q) => q.id)).toEqual([due.id]);
    expect(expired[0]).toMatchObject({
      status: 'defaulted',
      answer: 'SQLite',
      answeredVia: 'timeout',
      answeredAt: '2026-10-18T09:16:00.000Z',
    });
    expect(store.questions.expireDue()).toEqual([]);
    expect(store.questions.get(later.id)?.status).toBe('pending');
    expect(store.questions.get(answered.id)?.answer).toBe('Postgres');

    // A late human answer after the default does not override it, and did not default it.
    expect(store.questions.answer(due.id, 'Postgres', 'dashboard')).toMatchObject({
      accepted: false,
      defaultedNow: false,
    });
    expect(store.questions.nextDeadline()).toBe(later.deadline);
  });
});
