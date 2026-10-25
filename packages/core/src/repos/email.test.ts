import { describe, expect, it } from 'vitest';
import { FakeClock } from '../clock.js';
import { openStore } from '../store.js';

describe('email threads', () => {
  it('keeps threads, their mails and how far the inbox was read', () => {
    const clock = new FakeClock('2026-10-25T09:00:00.000Z');
    const store = openStore({ clock });
    const thread = store.email.createThread({
      sender: 'Dana@Acme.com',
      subject: 'Dark mode',
      mailThreadId: '17',
    });
    expect(thread).toMatchObject({ sender: 'dana@acme.com', state: 'clarifying', requestId: null });
    expect(store.email.threadByMailThreadId('17')?.id).toBe(thread.id);

    store.email.addMessage({
      threadId: thread.id,
      messageId: '<a@acme.com>',
      direction: 'in',
      text: 'Add it',
    });
    const request = store.requests.create({ text: 'Add it', source: 'email' });
    const project = store.projects.create({ name: 'p' });
    const session = store.sessions.create({ projectId: project.id, title: 's', model: 'opus', branch: 'b' });
    const q = store.questions.create({
      sessionId: session.id,
      text: 'Q?',
      options: ['a'],
      recommendedOption: 'a',
    });
    store.email.addMessage({
      threadId: thread.id,
      messageId: '<b@x>',
      direction: 'out',
      text: 'Q?',
      questionId: q.id,
    });
    expect(() =>
      store.email.addMessage({ threadId: thread.id, messageId: '<b@x>', direction: 'out', text: 'again' }),
    ).toThrow(/UNIQUE/);
    expect(store.email.messages(thread.id).map((m) => m.messageId)).toEqual(['<a@acme.com>', '<b@x>']);
    expect(store.email.messageForQuestion(q.id)?.messageId).toBe('<b@x>');
    expect(store.email.messageByMessageId('<a@acme.com>')?.threadId).toBe(thread.id);

    store.email.updateThread(thread.id, { state: 'building', requestId: request.id });
    expect(store.email.threads({ state: 'building' }).map((t) => t.requestId)).toEqual([request.id]);
    expect(store.email.threads({ state: 'clarifying' })).toEqual([]);

    expect(store.email.cursor('LOOP@x.com')).toBeUndefined();
    store.email.setCursor('loop@x.com', { uidValidity: 3, lastUid: 10 });
    store.email.setCursor('loop@x.com', { uidValidity: 3, lastUid: 12 });
    expect(store.email.cursor('Loop@X.com')).toEqual({ uidValidity: 3, lastUid: 12 });
    store.close();
  });
});
