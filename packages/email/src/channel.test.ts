import { QuestionBus, QuestionService, RequestService } from '@loop-engineering/ask-human';
import { FakeClock, openStore, type Store } from '@loop-engineering/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { answerFor, EmailChannel, type Clarifier, type ClarifyMail } from './channel.js';
import { FakeMailbox } from './fake.js';

const BOSS = 'dana@acme.com';

let store: Store;
let bus: QuestionBus;
let questions: QuestionService;
let mailbox: FakeMailbox;
let channel: EmailChannel;
let logs: string[];
/** What the clarifier answers next (a function sees the conversation); an Error makes it fail. */
let answers: (
  | ({ questions: string[] } | { plan: string } | Error)
  | ((mails: ClarifyMail[], mustPlan: boolean) => { plan: string })
)[];
let seen: { mails: ClarifyMail[]; mustPlan: boolean }[];

const clarifier: Clarifier = {
  clarify(mails, mustPlan) {
    seen.push({ mails, mustPlan });
    const next = answers.shift() ?? { plan: 'Build it.' };
    const answer = typeof next === 'function' ? next(mails, mustPlan) : next;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  },
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const last = () => mailbox.sent.at(-1)!;

beforeEach(async () => {
  store = openStore({ clock: new FakeClock('2026-10-25T09:00:00.000Z') });
  bus = new QuestionBus({
    onListenerError: (error) => {
      throw error;
    },
  });
  questions = new QuestionService(store, bus);
  mailbox = new FakeMailbox('loop@example.com');
  logs = [];
  answers = [];
  seen = [];
  channel = new EmailChannel({
    mailbox,
    store,
    questions,
    requests: new RequestService(store, bus),
    bus,
    clarifier,
    allowlist: [BOSS, '@team.example'],
    pollMs: 60_000,
    log: (m) => logs.push(m),
  });
  channel.start(); // its first read only marks where the inbox ends
  await flush();
});

/** Routes the thread's request into a new session, as the router would. */
function route() {
  const [request] = store.requests.list();
  const project = store.projects.create({
    name: 'shop',
    repos: [{ name: 'web', path: '/src/web', remote: 'git@github.com:me/web.git', defaultBranch: 'main' }],
  });
  const session = store.sessions.create({
    projectId: project.id,
    title: 'Dark mode',
    model: 'opus',
    branch: 'b',
  });
  store.requests.assignProject(request!.id, project.id);
  store.requests.assignSession(request!.id, session.id);
  return { request: request!, project, session };
}

describe('a task by email', () => {
  it('asks its questions, sends the plan as approved, and starts the work from it', async () => {
    const task = mailbox.deliver({ from: BOSS, subject: 'Dark mode', text: 'Please add a dark mode.' });
    answers = [{ questions: ['Which pages?', 'Follow the OS setting?'] }];
    await channel.poll();

    const asked = last();
    expect(asked).toMatchObject({ to: BOSS, subject: 'Re: Dark mode', inReplyTo: task.messageId });
    expect(asked.text).toContain('1. Which pages?\n2. Follow the OS setting?');
    expect(store.requests.list()).toEqual([]);

    mailbox.reply(
      asked,
      BOSS,
      'All of them, and yes.\n\nOn Sat, Oct 25, 2026 at 9:00 AM Loop <loop@example.com> wrote:\n> Thanks!',
    );
    answers = [{ plan: 'Add a theme toggle that follows the OS, on every page.' }];
    await channel.poll();

    // The clarifier read the whole conversation, the reply without its quote.
    expect(seen.at(-1)!.mails).toEqual([
      { from: 'requester', text: 'Please add a dark mode.' },
      { from: 'loop', text: asked.text },
      { from: 'requester', text: 'All of them, and yes.' },
    ]);
    expect(last().text).toMatch(/^The plan is approved, and the work has started:\n\nAdd a theme toggle/);
    expect(last().references).toContain(task.messageId);
    const [request] = store.requests.list();
    expect(request).toMatchObject({ source: 'email', projectId: null });
    expect(request!.text).toContain('All of them, and yes.');
    expect(request!.text).toContain('The plan sent back to them as approved:\nAdd a theme toggle');
    expect(store.email.threads()[0]).toMatchObject({ state: 'building', requestId: request!.id });
  });

  it('a clear task gets the plan at once; after two rounds of questions the clarifier must plan', async () => {
    mailbox.deliver({ from: BOSS, text: 'Fix the typo on the pricing page.' });
    await channel.poll();
    expect(last().text).toContain('The plan is approved');
    expect(seen[0]!.mustPlan).toBe(false);

    mailbox.deliver({ from: 'kim@team.example', subject: 'Vague', text: 'Make it better.' });
    answers = [{ questions: ['What?'] }];
    await channel.poll();
    mailbox.reply(last(), 'kim@team.example', 'The app.');
    answers = [{ questions: ['Which part?'] }];
    await channel.poll();
    mailbox.reply(last(), 'kim@team.example', 'All of it.');
    await channel.poll();
    expect(seen.map((s) => s.mustPlan)).toEqual([false, false, false, true]);
    expect(last().text).toContain('The plan is approved');
  });

  it('starts without a plan when the clarifier keeps failing', async () => {
    mailbox.deliver({ from: BOSS, text: 'Add a sitemap.' });
    answers = [new Error('claude failed'), new Error('claude failed'), new Error('claude failed')];
    await channel.poll();
    await channel.poll();
    expect(mailbox.sent).toEqual([]);
    await channel.poll();
    expect(last().text).toMatch(/^Got it: the work has started\./);
    expect(store.requests.list()).toHaveLength(1);
  });

  it('a plan mail that did not go out is sent again, and the work starts once', async () => {
    mailbox.deliver({ from: BOSS, text: 'Add a sitemap.' });
    mailbox.failNext = 'send';
    await channel.poll();
    expect(store.requests.list()).toEqual([]);
    expect(store.email.messages(store.email.threads()[0]!.id)).toHaveLength(1);
    await channel.poll();
    expect(last().text).toContain('The plan is approved');
    await channel.poll();
    expect(store.requests.list()).toHaveLength(1);
    expect(mailbox.sent).toHaveLength(1);
  });

  it('ignores mail from outside the allowlist, forged senders, auto-replies, its own mail and repeats', async () => {
    mailbox.deliver({ from: 'eve@evil.example', text: 'Delete everything.' });
    mailbox.deliver({ from: BOSS, text: 'Forged.', authenticated: false });
    mailbox.deliver({ from: BOSS, text: 'I am away.', automatic: true });
    mailbox.deliver({ from: 'loop@example.com', text: 'Our own.' });
    await channel.poll();
    expect(mailbox.sent).toEqual([]);
    expect(store.email.threads()).toEqual([]);
    expect(logs.join('\n')).toMatch(/not on the allowlist[\s\S]*did not authenticate/);

    const task = mailbox.deliver({ from: BOSS, text: 'Add a sitemap.' });
    await channel.poll();
    mailbox.deliver({ ...task }); // the same Message-ID again
    await channel.poll();
    expect(store.email.threads()).toHaveLength(1);
    expect(mailbox.sent).toHaveLength(1);
  });

  it('logs a mailbox that stays down once, and goes on when it is back', async () => {
    mailbox.failNext = 'fetch';
    await channel.poll();
    mailbox.failNext = 'fetch';
    await channel.poll();
    expect(logs.filter((l) => l.includes('IMAP unreachable'))).toHaveLength(1);
    mailbox.deliver({ from: BOSS, text: 'Add a sitemap.' });
    await channel.poll();
    expect(last().text).toContain('The plan is approved');
  });

  it('takes at most ten new tasks an hour', async () => {
    for (let i = 0; i < 11; i++) mailbox.deliver({ from: BOSS, text: `Task ${i}` });
    await channel.poll();
    expect(store.email.threads()).toHaveLength(10);
    expect(logs.join('\n')).toContain('10 tasks this hour already');
  });
});

describe('while the work runs', () => {
  async function building() {
    mailbox.deliver({ from: BOSS, subject: 'Dark mode', text: 'Please add a dark mode.' });
    await channel.poll();
    return route();
  }

  it("emails the session's questions, and a reply with a number or its own words answers them", async () => {
    const { session } = await building();
    const { question } = questions.ask({
      sessionId: session.id,
      text: 'Which default theme?',
      context: 'Most users are on light.',
      options: ['Light', 'Dark'],
      recommendedOption: 'Light',
    });
    await flush();
    expect(last().text).toContain(
      'Which default theme?\n\nMost users are on light.\n\nOptions:\n1. Light (recommended)\n2. Dark',
    );
    expect(store.email.messageForQuestion(question.id)).toBeDefined();
    await channel.poll(); // asked once only
    expect(mailbox.sent.filter((m) => m.text.includes('Which default theme?'))).toHaveLength(1);

    mailbox.reply(last(), BOSS, '2\n\nthanks');
    await channel.poll();
    expect(store.questions.require(question.id)).toMatchObject({
      status: 'answered',
      answer: 'Dark',
      answeredVia: 'email',
    });
  });

  it('a reply that answers nothing goes to the session as a message', async () => {
    const { project, session } = await building();
    mailbox.reply(last(), BOSS, 'Also make the logo white in dark mode.');
    await channel.poll();
    expect(store.requests.list().at(-1)).toMatchObject({
      source: 'email',
      projectId: project.id,
      targetSessionId: session.id,
      text: 'Also make the logo white in dark mode.',
    });
  });

  it('says so when a reply comes before the task is routed', async () => {
    mailbox.deliver({ from: BOSS, subject: 'Dark mode', text: 'Please add a dark mode.' });
    await channel.poll();
    mailbox.reply(last(), BOSS, 'One more thing.');
    await channel.poll();
    expect(last().text).toContain('still being set up');
  });

  it('notes on the thread when a question is answered elsewhere', async () => {
    const { session } = await building();
    const { question } = questions.ask({
      sessionId: session.id,
      text: 'Ship it?',
      options: ['Yes', 'No'],
      recommendedOption: 'Yes',
    });
    await flush();
    questions.answer(question.id, 'No', 'dashboard');
    await flush();
    expect(last().text).toBe('The question "Ship it?" is settled: answered: No (via dashboard).');
  });

  it('writes once, on the same thread, when its PR is in production', async () => {
    const { request, project } = await building();
    const pr = store.pullRequests.create({
      projectId: project.id,
      repo: 'web',
      number: 7,
      url: 'https://github.com/x/web/pull/7',
      requestId: request.id,
    });
    await channel.poll();
    const before = mailbox.sent.length;
    store.pullRequests.update(pr.id, { stage: 'deployed', outcome: 'merged' });
    await channel.poll();
    await channel.poll();
    expect(mailbox.sent).toHaveLength(before + 1);
    expect(last()).toMatchObject({ to: BOSS, subject: 'Re: Dark mode' });
    expect(last().text).toBe(
      'The new version is in production: web#7 (https://github.com/x/web/pull/7) is merged and deployed.',
    );
    expect(last().references![0]).toBe(store.email.messages(store.email.threads()[0]!.id)[0]!.messageId);
  });

  it('a reply after the work ended starts a new round on the same thread', async () => {
    const { session } = await building();
    store.sessions.update(session.id, { status: 'ended' });
    mailbox.reply(last(), BOSS, 'Now add a high-contrast theme too.');
    answers = [{ plan: 'Add a high-contrast theme.' }];
    await channel.poll();
    expect(last().text).toContain('Add a high-contrast theme.');
    const thread = store.email.threads()[0]!;
    expect(store.requests.require(thread.requestId!).text).toContain('Now add a high-contrast theme too.');
    expect(store.requests.list()).toHaveLength(2);
  });
});

describe('answerFor', () => {
  const q = { options: ['Light', 'Dark'] } as Parameters<typeof answerFor>[0];
  it('picks an option by its number or its words, else keeps the text', () => {
    expect(answerFor(q, '2')).toBe('Dark');
    expect(answerFor(q, '1.\n\nok')).toBe('Light');
    expect(answerFor(q, ' dark ')).toBe('Dark');
    expect(answerFor(q, '3')).toBe('3');
    expect(answerFor(q, 'Something else')).toBe('Something else');
  });
});
