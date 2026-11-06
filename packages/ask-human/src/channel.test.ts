import type { HumanChannel, Question } from '@loop-engineering/core';
import { QUESTION_TIMEOUT_MS } from '@loop-engineering/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QuestionResolvedEvent } from './bus.js';
import { attachChannel, type QuestionChannel } from './channel.js';
import { harness, newQuestion, type Harness } from './testing/harness.js';

class RecordingChannel implements QuestionChannel {
  posted: Question[] = [];
  confirmations: string[] = [];
  won: QuestionResolvedEvent[] = [];
  constructor(readonly name: HumanChannel) {}
  onQuestion(question: Question) {
    this.posted.push(question);
  }
  onResolvedElsewhere(_event: QuestionResolvedEvent, confirmation: string) {
    this.confirmations.push(confirmation);
  }
  onResolvedHere(event: QuestionResolvedEvent) {
    this.won.push(event);
  }
}

let h: Harness;
let email: RecordingChannel;
let dashboard: RecordingChannel;
beforeEach(() => {
  h = harness();
  email = new RecordingChannel('email');
  dashboard = new RecordingChannel('dashboard');
  attachChannel(h.bus, email);
  attachChannel(h.bus, dashboard);
});
afterEach(() => h.close());

describe('attachChannel', () => {
  it('posts new questions to every channel and confirms on the ones that did not win', () => {
    const { question } = h.service.ask(newQuestion(h.session.id));
    expect(email.posted.map((q) => q.id)).toEqual([question.id]);
    expect(dashboard.posted.map((q) => q.id)).toEqual([question.id]);

    h.service.answer(question.id, 'Postgres', 'dashboard');
    h.service.answer(question.id, 'SQLite', 'email'); // too late, first answer won
    expect(dashboard.won.map((e) => e.answer)).toEqual(['Postgres']);
    expect(dashboard.confirmations).toEqual([]);
    expect(email.won).toEqual([]);
    expect(email.confirmations).toEqual(['answered: Postgres (via dashboard)']);
  });

  it('confirms a default on every channel', () => {
    h.sweeper.start();
    h.service.ask(newQuestion(h.session.id));
    h.timers.advance(QUESTION_TIMEOUT_MS);
    const expected = 'no answer in 15 min, went with the recommended option: SQLite';
    expect(email.confirmations).toEqual([expected]);
    expect(dashboard.confirmations).toEqual([expected]);
  });

  it('detaches', () => {
    const sms = new RecordingChannel('email');
    const detach = attachChannel(h.bus, sms);
    detach();
    h.service.ask(newQuestion(h.session.id));
    expect(sms.posted).toEqual([]);
  });
});
