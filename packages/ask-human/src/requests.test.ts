import { openStore } from '@loop-engineering/core';
import { describe, expect, it } from 'vitest';
import { QuestionBus, type BusEvent } from './bus.js';
import { RequestService } from './requests.js';

describe('RequestService', () => {
  it('stores the request and emits request.created', () => {
    const store = openStore();
    const bus = new QuestionBus();
    const events: BusEvent[] = [];
    bus.onAny((e) => {
      events.push(e);
    });
    const request = new RequestService(store, bus).create({ text: 'Add dark mode', source: 'dashboard' });
    expect(store.requests.list()).toEqual([request]);
    expect(events).toEqual([{ type: 'request.created', request }]);
    store.close();
  });

  it('emits nothing when the request is invalid', () => {
    const store = openStore();
    const bus = new QuestionBus();
    let emitted = 0;
    bus.onAny(() => {
      emitted++;
    });
    expect(() => new RequestService(store, bus).create({ text: ' ', source: 'telegram' })).toThrow();
    expect(emitted).toBe(0);
    store.close();
  });
});
