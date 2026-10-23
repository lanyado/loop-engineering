import type { Question } from '@loop-engineering/core';
import { describe, expect, it, vi } from 'vitest';
import { QuestionBus, type QuestionEvent } from './bus.js';

const question = { id: 1 } as Question;
const created: QuestionEvent = { type: 'question.created', question };
const resolved: QuestionEvent = {
  type: 'question.resolved',
  question,
  answer: 'SQLite',
  answeredVia: 'dashboard',
  defaulted: false,
};

describe('QuestionBus', () => {
  it('delivers each event to listeners of its type and to onAny listeners, in order', () => {
    const bus = new QuestionBus();
    const seen: string[] = [];
    bus.on('question.created', (e) => {
      seen.push(`created:${e.question.id}`);
    });
    bus.on('question.resolved', (e) => {
      seen.push(`resolved:${e.answer}`);
    });
    bus.onAny((e) => {
      seen.push(`any:${e.type}`);
    });
    bus.emit(created);
    bus.emit(resolved);
    expect(seen).toEqual(['created:1', 'any:question.created', 'resolved:SQLite', 'any:question.resolved']);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new QuestionBus();
    const listener = vi.fn();
    const off = bus.on('question.created', listener);
    expect(bus.listenerCount).toBe(1);
    off();
    bus.emit(created);
    expect(listener).not.toHaveBeenCalled();
    expect(bus.listenerCount).toBe(0);
  });

  it('isolates listeners that throw or reject', async () => {
    const errors: unknown[] = [];
    const bus = new QuestionBus({ onListenerError: (error) => errors.push(error) });
    const after = vi.fn();
    bus.on('question.created', () => {
      throw new Error('sync boom');
    });
    bus.on('question.created', () => Promise.reject(new Error('async boom')));
    bus.on('question.created', after);
    expect(() => bus.emit(created)).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(errors.map((e) => (e as Error).message)).toEqual(['sync boom', 'async boom']);
  });

  it('lets a listener unsubscribe another mid-emit without skipping the current round', () => {
    const bus = new QuestionBus();
    const second = vi.fn();
    let offSecond = () => {};
    bus.on('question.created', () => offSecond());
    offSecond = bus.on('question.created', second);
    bus.emit(created);
    expect(second).toHaveBeenCalledOnce();
    bus.emit(created);
    expect(second).toHaveBeenCalledOnce();
  });
});
