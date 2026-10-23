import {
  DeadlineSweeper,
  FakeTimers,
  QuestionBus,
  QuestionService,
  RequestService,
  type BusEvent,
} from '@loop-engineering/ask-human';
import {
  FakeClock,
  openStore,
  QUESTION_TIMEOUT_MS,
  type NewQuestion,
  type Store,
} from '@loop-engineering/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelegramBot } from './bot.js';
import { mockUser, MockTelegram, type MockMessage } from './mock.js';
import { TELEGRAM_LIMITS } from './transport.js';

const OWNER = mockUser(111, 'Rotem');
const FRIEND = mockUser(222, 'Dana');
const STRANGER = mockUser(999, 'Eve');

let clock: FakeClock;
let timers: FakeTimers;
let store: Store;
let bus: QuestionBus;
let questions: QuestionService;
let sweeper: DeadlineSweeper;
let tg: MockTelegram;
let bot: TelegramBot;
let logs: string[];
let events: BusEvent[];
let sessionId: number;

/** Lets the bot's async listeners (sends, edits) run to completion; MockTelegram resolves at once. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function startBot(): TelegramBot {
  const next = new TelegramBot({
    transport: tg,
    store,
    questions,
    requests: new RequestService(store, bus),
    bus,
    ownerId: OWNER.id,
    timeZone: 'UTC',
    log: (m) => logs.push(m),
  });
  next.attach();
  tg.startPolling((u) => next.handleUpdate(u));
  return next;
}

beforeEach(() => {
  clock = new FakeClock('2026-10-18T09:00:00.000Z');
  timers = new FakeTimers(clock);
  store = openStore({ clock });
  const project = store.projects.create({ name: 'shop' });
  sessionId = store.sessions.create({
    projectId: project.id,
    title: 'Fix checkout',
    model: 'opus',
    branch: 'b',
  }).id;
  store.settings.update({ telegramAllowlist: [FRIEND.id] });
  bus = new QuestionBus({
    onListenerError: (error) => {
      throw error;
    },
  });
  events = [];
  bus.onAny((e) => {
    events.push(e);
  });
  questions = new QuestionService(store, bus);
  sweeper = new DeadlineSweeper(questions, { timers });
  tg = new MockTelegram();
  logs = [];
  bot = startBot();
});

afterEach(async () => {
  await bot.close();
  sweeper.stop();
  store.close();
});

async function ask(extra: Partial<NewQuestion> = {}) {
  const { question } = questions.ask({
    sessionId,
    text: 'Which database?',
    options: ['SQLite', 'Postgres'],
    recommendedOption: 'SQLite',
    ...extra,
  });
  await flush();
  return question;
}

/** The first question message (the one sent with buttons) a user got. */
const questionMessage = (userId: number): MockMessage => {
  const message = tg.sentTo(userId).find((m) => m.history[0]!.includes('Tap an option'));
  if (!message) throw new Error(`no question message for ${userId}`);
  return message;
};

describe('access control', () => {
  it('ignores strangers silently and logs them at most once per window', async () => {
    await tg.sendText(STRANGER, 'hello');
    await tg.sendText(STRANGER, 'build me a thing');
    const question = await ask();
    await tg.tap(STRANGER, questionMessage(OWNER.id), 'Postgres');

    expect(tg.sentTo(STRANGER.id)).toEqual([]);
    expect(tg.callbackAnswers).toEqual([]);
    expect(store.requests.list()).toEqual([]);
    expect(store.questions.require(question.id).status).toBe('pending');
    expect(logs.filter((l) => l.includes('ignored'))).toEqual([
      '[telegram] ignored message from user 999 (not the owner or on the allowlist)',
    ]);

    clock.advance(10 * 60_000);
    await tg.sendText(STRANGER, 'again');
    expect(logs.filter((l) => l.includes('ignored'))).toHaveLength(2);
  });

  it('caps ignored-update logging across many users', async () => {
    for (let id = 5000; id < 5100; id++) await tg.sendText(mockUser(id), 'spam');
    expect(logs.filter((l) => l.includes('ignored'))).toHaveLength(20);
    clock.advance(10 * 60_000);
    await tg.sendText(mockUser(6000), 'spam');
    expect(logs).toContain('[telegram] 80 more updates from unknown users were ignored');
  });

  it('applies dashboard allowlist edits to the very next update', async () => {
    await tg.sendText(STRANGER, 'first');
    expect(store.requests.list()).toHaveLength(0);

    store.settings.update({ telegramAllowlist: [FRIEND.id, STRANGER.id] });
    await tg.sendText(STRANGER, 'second');
    expect(store.requests.list().map((r) => r.text)).toEqual(['second']);

    store.settings.update({ telegramAllowlist: [] });
    await tg.sendText(FRIEND, 'third');
    await tg.sendText(OWNER, 'fourth');
    expect(store.requests.list().map((r) => r.text)).toEqual(['second', 'fourth']);
  });

  it('refuses a tap that carries no message (unknown chat)', async () => {
    const question = await ask();
    const update = tg.callbackUpdate(OWNER, questionMessage(OWNER.id), `a:${question.id}:1`);
    delete update.callback_query!.message;
    await tg.inject(update);
    expect(tg.callbackAnswers).toEqual([]);
    expect(store.questions.require(question.id).status).toBe('pending');
  });

  it('ignores group chats, even from the owner', async () => {
    const update = tg.messageUpdate(OWNER, 'in a group');
    update.message!.chat = { id: -100, type: 'group', title: 'team' };
    await tg.inject(update);
    expect(tg.messages).toEqual([]);
    expect(store.requests.list()).toEqual([]);
  });
});

describe('sending questions', () => {
  it('sends each question to the owner and the allowlist, with one button per option', async () => {
    const question = await ask({ context: 'Single-user app.' });
    for (const user of [OWNER, FRIEND]) {
      const message = questionMessage(user.id);
      expect(message.text).toBe(
        [
          `Question #${question.id} · shop / Fix checkout (session ${sessionId})`,
          '',
          'Which database?',
          '',
          'Context:\nSingle-user app.',
          '',
          'Options:\n1. SQLite (recommended)\n2. Postgres',
          '',
          'Tap an option or reply to this message with your own answer.\n' +
            'Deadline 09:15 UTC (in 15 min); no answer by then → SQLite.',
        ].join('\n'),
      );
      expect(message.keyboard).toEqual([
        [{ text: 'SQLite ★', data: `a:${question.id}:0` }],
        [{ text: 'Postgres', data: `a:${question.id}:1` }],
      ]);
      expect(message.silent).toBe(false);
    }
  });

  it('names the subagent asking', async () => {
    const subagent = store.subagents.create({
      sessionId,
      title: 'db-migration',
      model: 'sonnet',
      effort: 'high',
    });
    await ask({ subagentId: subagent.id });
    expect(questionMessage(OWNER.id).text.split('\n')[0]).toContain(', subagent db-migration');
  });

  it('still reaches the others when one recipient cannot be messaged', async () => {
    tg.blockedChats.add(FRIEND.id);
    const question = await ask();
    expect(questionMessage(OWNER.id).text).toContain('Which database?');
    expect(logs.some((l) => l.includes(`could not send question ${question.id} to ${FRIEND.id}`))).toBe(true);
  });

  it('splits a question too long for one message and keeps every part within the limits', async () => {
    const options = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(200));
    const question = await ask({
      text: `${'word '.repeat(599)}end.`, // 3000 characters
      context: 'c'.repeat(2000),
      options,
      recommendedOption: options[3]!,
    });
    const sent = tg.sentTo(OWNER.id);
    expect(sent.length).toBeGreaterThan(1);
    for (const m of sent) expect(m.text.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.text);
    expect(sent[0]!.text.startsWith(`Question #${question.id} (details 1/`)).toBe(true);
    const joined = sent.map((m) => m.text).join('\n');
    expect(joined).toContain('end.');
    expect(joined).toContain('c'.repeat(2000).slice(0, 1000));
    const last = sent.at(-1)!;
    expect(last.keyboard.flat()).toHaveLength(10);
    expect(last.text).toContain('(full question in the message above)');
    expect(last.text).toContain(`4. ${options[3]} (recommended)`);
    for (const button of last.keyboard.flat()) {
      expect(Buffer.byteLength(button.data)).toBeLessThanOrEqual(TELEGRAM_LIMITS.callbackData);
      expect(button.text.length).toBeLessThanOrEqual(50);
    }
    // A reply to a details message answers the same question.
    await tg.sendText(OWNER, 'Use option 3', sent[0]);
    expect(store.questions.require(question.id)).toMatchObject({
      status: 'answered',
      answer: 'Use option 3',
    });
    await flush();
    expect(last.keyboard).toEqual([]);
    expect(last.text.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.text);
  });
});

describe('answers from Telegram', () => {
  it('a tap answers the question, edits every copy and removes the buttons', async () => {
    const question = await ask();
    const waiting = questions.wait(question.id);
    const id = await tg.tap(FRIEND, questionMessage(FRIEND.id), 'Postgres');

    expect(await waiting).toMatchObject({ answer: 'Postgres', answeredVia: 'telegram' });
    expect(tg.answerFor(id)).toBe('answered: Postgres');
    await flush();
    for (const user of [OWNER, FRIEND]) {
      const message = questionMessage(user.id);
      expect(message.keyboard).toEqual([]);
      expect(message.text).toMatch(
        /Options:\n1\. SQLite \(recommended\)\n2\. Postgres\n\nAnswered: Postgres \(via telegram, by Dana\)$/,
      );
      expect(message.text).not.toContain('Tap an option');
    }
    // Resolved here: no "answered elsewhere" confirmation is posted.
    expect(tg.messages.filter((m) => m.text.startsWith('answered:'))).toEqual([]);
  });

  it('a reply with free text answers with that text', async () => {
    const question = await ask();
    await tg.sendText(OWNER, 'MySQL, we already run it', questionMessage(OWNER.id));
    expect(store.questions.require(question.id)).toMatchObject({
      answer: 'MySQL, we already run it',
      answeredVia: 'telegram',
    });
    expect(tg.last(OWNER.id).text).toBe(`answered #${question.id}: MySQL, we already run it`);
    await flush();
    expect(questionMessage(OWNER.id).text).toContain(
      'Answered: MySQL, we already run it (via telegram, by Rotem)',
    );
    expect(store.requests.list()).toEqual([]);
  });

  it('a reply starting with "/" answers the question unless it is a command', async () => {
    const question = await ask();
    await tg.sendText(OWNER, '/status', questionMessage(OWNER.id));
    expect(tg.last(OWNER.id).text.startsWith('Pending questions: 1')).toBe(true);
    await tg.sendText(OWNER, '/tmp is fine, use it', questionMessage(OWNER.id));
    expect(store.questions.require(question.id).answer).toBe('/tmp is fine, use it');
  });

  it('a plain message matching an option of the only pending question answers it', async () => {
    const question = await ask();
    await tg.sendText(OWNER, '  postgres ');
    expect(store.questions.require(question.id)).toMatchObject({
      answer: 'Postgres',
      answeredVia: 'telegram',
    });
    expect(tg.last(OWNER.id).text).toBe(`answered #${question.id}: Postgres`);
    expect(store.requests.list()).toEqual([]);
  });

  it('a plain message matching an option is a new task when several questions are pending', async () => {
    const first = await ask();
    await ask({ text: 'Which cache?', options: ['Redis', 'Postgres'], recommendedOption: 'Redis' });
    await tg.sendText(OWNER, 'Postgres');
    expect(store.questions.require(first.id).status).toBe('pending');
    expect(store.requests.list().map((r) => r.text)).toEqual(['Postgres']);
  });

  it('refuses an answer over the size cap and keeps the question open', async () => {
    const question = await ask();
    await tg.sendText(OWNER, 'x'.repeat(2001), questionMessage(OWNER.id));
    expect(tg.last(OWNER.id).text).toBe('Not accepted: answer must be at most 2000 characters.');
    expect(store.questions.require(question.id).status).toBe('pending');
    expect(questionMessage(OWNER.id).keyboard).toHaveLength(2);
  });

  it('answers duplicate and late taps with "already answered"', async () => {
    const question = await ask();
    const ownerCopy = questionMessage(OWNER.id);
    const friendCopy = { ...questionMessage(FRIEND.id) }; // as Dana's client still shows it
    await tg.tap(OWNER, ownerCopy, 'SQLite');
    // Dana taps on her copy before her client saw the edit.
    const late = await tg.tap(FRIEND, friendCopy, 'Postgres');
    expect(tg.answerFor(late)).toBe('already answered: SQLite (via telegram)');
    expect(store.questions.require(question.id).answer).toBe('SQLite');
    await tg.sendText(FRIEND, 'Postgres!', friendCopy);
    expect(tg.last(FRIEND.id).text).toBe('already answered: SQLite (via telegram)');
  });

  it('rejects malformed callback data', async () => {
    await ask();
    await tg.inject(tg.callbackUpdate(OWNER, questionMessage(OWNER.id), 'a:999:0'));
    await tg.inject(tg.callbackUpdate(OWNER, questionMessage(OWNER.id), 'Postgres'));
    expect(tg.callbackAnswers.map((a) => a.text)).toEqual([
      'This button is no longer valid.',
      'This button is no longer valid.',
    ]);
  });
});

describe('first answer wins across channels', () => {
  it('a dashboard answer edits the messages, confirms quietly, and a later tap is refused', async () => {
    const question = await ask();
    const stale = { ...questionMessage(OWNER.id) };
    expect(questions.answer(question.id, 'Postgres', 'dashboard').accepted).toBe(true);
    await flush();

    for (const user of [OWNER, FRIEND]) {
      const message = questionMessage(user.id);
      expect(message.keyboard).toEqual([]);
      expect(message.text.endsWith('\n\nAnswered: Postgres (via dashboard)')).toBe(true);
      const confirmation = tg.last(user.id);
      expect(confirmation).toMatchObject({
        text: 'answered: Postgres (via dashboard)',
        replyTo: message.messageId,
        silent: true,
      });
    }

    const tap = await tg.tap(OWNER, stale, 'SQLite');
    expect(tg.answerFor(tap)).toBe('already answered: Postgres (via dashboard)');
    expect(store.questions.require(question.id)).toMatchObject({
      answer: 'Postgres',
      answeredVia: 'dashboard',
    });
  });

  it('a Telegram tap first makes the dashboard answer lose', async () => {
    const question = await ask();
    await tg.tap(OWNER, questionMessage(OWNER.id), 'Postgres');
    expect(questions.answer(question.id, 'SQLite', 'dashboard').accepted).toBe(false);
    expect(store.questions.require(question.id)).toMatchObject({
      answer: 'Postgres',
      answeredVia: 'telegram',
    });
  });
});

describe('defaults', () => {
  it('shows the default after 15 minutes and refuses later taps', async () => {
    sweeper.start();
    const question = await ask();
    const copy = { ...questionMessage(OWNER.id) };
    timers.advance(QUESTION_TIMEOUT_MS);
    await flush();
    expect(store.questions.require(question.id).status).toBe('defaulted');

    const message = questionMessage(OWNER.id);
    expect(message.keyboard).toEqual([]);
    expect(message.text.endsWith('\n\nNo answer in 15 min → went with the recommended option: SQLite')).toBe(
      true,
    );
    expect(tg.last(OWNER.id)).toMatchObject({
      text: 'no answer in 15 min, went with the recommended option: SQLite',
      silent: true,
    });

    const tap = await tg.tap(OWNER, copy, 'Postgres');
    expect(tg.answerFor(tap)).toBe('already settled: no answer in 15 min → went with SQLite');
  });

  it('a tap right after the deadline, before the sweep, defaults the question', async () => {
    const question = await ask();
    clock.advance(QUESTION_TIMEOUT_MS + 1);
    const tap = await tg.tap(OWNER, questionMessage(OWNER.id), 'Postgres');
    expect(tg.answerFor(tap)).toBe('already settled: no answer in 15 min → went with SQLite');
    expect(store.questions.require(question.id).status).toBe('defaulted');
  });
});

describe('after a restart', () => {
  it('a tap or reply on an old message still answers, and the tapped message is edited', async () => {
    const first = await ask();
    const second = await ask({ text: 'Which queue?', options: ['SQS', 'Redis'], recommendedOption: 'SQS' });
    await bot.close();
    bot = startBot(); // fresh memory, same store

    const firstCopy = tg.sentTo(OWNER.id).find((m) => m.text.includes('Which database?'))!;
    await tg.tap(OWNER, firstCopy, 'Postgres');
    expect(store.questions.require(first.id).answer).toBe('Postgres');
    await flush();
    expect(firstCopy.keyboard).toEqual([]);
    expect(firstCopy.text).toContain('Answered: Postgres (via telegram, by Rotem)');

    const secondCopy = tg.sentTo(OWNER.id).find((m) => m.text.includes('Which queue?'))!;
    await tg.sendText(OWNER, 'Kafka', secondCopy);
    expect(store.questions.require(second.id).answer).toBe('Kafka');
  });

  it('a question answered elsewhere gets a confirmation naming it', async () => {
    const question = await ask();
    await bot.close();
    bot = startBot();
    const before = tg.messages.length;
    questions.answer(question.id, 'Postgres', 'dashboard');
    await flush();
    expect(tg.messages.slice(before).map((m) => [m.chatId, m.text])).toEqual([
      [OWNER.id, `Question #${question.id}: answered: Postgres (via dashboard)`],
      [FRIEND.id, `Question #${question.id}: answered: Postgres (via dashboard)`],
    ]);
  });

  it('a tap on a settled question with buttons still showing clears them', async () => {
    const question = await ask();
    await bot.close();
    questions.answer(question.id, 'Postgres', 'dashboard'); // no bot attached
    bot = startBot();
    const copy = questionMessage(OWNER.id);
    const tap = await tg.tap(OWNER, copy, 'SQLite');
    expect(tg.answerFor(tap)).toBe('already answered: Postgres (via dashboard)');
    expect(copy.keyboard).toEqual([]);
    expect(copy.text).toContain('Answered: Postgres (via dashboard)');
  });
});

describe('new tasks', () => {
  it('stores a plain message as an unrouted request and emits request.created', async () => {
    await tg.sendText(OWNER, '  Add dark mode to the shop  ');
    const [request] = store.requests.list();
    expect(request).toMatchObject({ text: 'Add dark mode to the shop', source: 'telegram', projectId: null });
    expect(events.filter((e) => e.type === 'request.created')).toEqual([
      { type: 'request.created', request },
    ]);
    expect(tg.last(OWNER.id).text).toBe(
      `Saved as request #${request!.id}. It will be routed to a project and session.\n` +
        'To answer a question instead, reply to the question message.',
    );
  });

  it('handles an update delivered twice only once', async () => {
    const update = tg.messageUpdate(OWNER, 'Add dark mode');
    await tg.inject(update);
    await tg.inject(update);
    expect(store.requests.list()).toHaveLength(1);
    expect(tg.sentTo(OWNER.id)).toHaveLength(1);
  });

  it('a reply to a bot message that is not a question is a new task', async () => {
    await tg.sendText(OWNER, 'first task');
    await tg.sendText(OWNER, 'second task', tg.last(OWNER.id));
    expect(store.requests.list().map((r) => r.text)).toEqual(['first task', 'second task']);
  });

  it('asks for text when a message has none', async () => {
    const update = tg.messageUpdate(OWNER, 'x');
    delete (update.message as { text?: string }).text;
    await tg.inject(update);
    expect(tg.last(OWNER.id).text).toBe('I only read text messages.');
    expect(store.requests.list()).toEqual([]);
  });
});

describe('commands', () => {
  it('/status lists pending questions and active sessions', async () => {
    const question = await ask();
    const project = store.projects.create({ name: 'web' });
    store.sessions.create({
      projectId: project.id,
      title: 'Landing page',
      model: 'glm',
      branch: 'x',
      provider: 'opencode',
      status: 'paused',
      pauseReason: 'usage_limit',
    });
    store.sessions.create({
      projectId: project.id,
      title: 'Old',
      model: 'opus',
      branch: 'y',
      status: 'ended',
    });
    store.requests.create({ text: 'unrouted', source: 'telegram' });
    clock.advance(5 * 60_000);
    await tg.sendText(OWNER, '/status');
    expect(tg.last(OWNER.id).text).toBe(
      [
        'Pending questions: 1',
        `#${question.id} Which database? (10 min left) /q${question.id}`,
        '',
        'Active sessions: 2',
        `#${sessionId + 1} web / Landing page: paused (usage_limit), opencode glm`,
        `#${sessionId} shop / Fix checkout: running, claude opus`,
        '',
        'Requests waiting for routing: 1',
      ].join('\n'),
    );
    expect(tg.last(OWNER.id).silent).toBe(false);
  });

  it('/q<id> shows a pending question again, with working buttons', async () => {
    const question = await ask();
    await tg.sendText(OWNER, `/q${question.id}`);
    await flush();
    const copies = tg.sentTo(OWNER.id).filter((m) => m.history[0]!.includes('Tap an option'));
    expect(copies).toHaveLength(2);
    await tg.tap(OWNER, copies[1]!, 'Postgres');
    await flush();
    expect(copies.every((m) => m.keyboard.length === 0)).toBe(true);
    await tg.sendText(OWNER, `/q ${question.id}`);
    expect(tg.last(OWNER.id).text).toBe('already answered: Postgres (via telegram)');
  });

  it('/start, /help and unknown commands explain the bot', async () => {
    await tg.sendText(OWNER, '/start');
    expect(tg.last(OWNER.id).text).toContain('/status');
    await tg.sendText(OWNER, '/nope');
    expect(tg.last(OWNER.id).text.startsWith('Unknown command /nope.')).toBe(true);
    expect(store.requests.list()).toEqual([]);
  });
});

describe('proactive messages', () => {
  it('sends nothing unprompted except questions and their confirmations', async () => {
    store.requests.create({ text: 'from the dashboard', source: 'dashboard' });
    bus.emit({ type: 'request.created', request: store.requests.list()[0]! });
    sweeper.start();
    timers.advance(60 * 60_000);
    await flush();
    expect(tg.messages).toEqual([]);
  });
});
