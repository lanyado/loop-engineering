import {
  DeadlineSweeper,
  FakeTimers,
  QuestionBus,
  QuestionService,
  RequestService,
} from '@loop-engineering/ask-human';
import {
  FakeClock,
  FolderBusyError,
  openStore,
  QUESTION_TIMEOUT_MS,
  type PauseReason,
  type Project,
  type Question,
  type Store,
} from '@loop-engineering/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClassifier, FakeFolderSessions, FakeMessenger, fakeStartSession } from './fakes.js';
import { CANCEL_OPTION } from './options.js';
import type { Plan } from './prompt.js';
import {
  deliverySentence,
  END_AND_START_FRESH,
  RESUME_AND_DELIVER,
  Router,
  type RouterConfig,
} from './router.js';
import { ensureRouterSession, findRouterSession, routerProjectId, ROUTER_PROJECT_NAME } from './system.js';
import type { ClassifierOutput } from './types.js';

let clock: FakeClock;
let timers: FakeTimers;
let store: Store;
let bus: QuestionBus;
let questions: QuestionService;
let requests: RequestService;
let sweeper: DeadlineSweeper;
let classifier: FakeClassifier;
let messenger: FakeMessenger;
let folders: FakeFolderSessions;
let startSession: ReturnType<typeof fakeStartSession>;
let router: Router;
let logs: string[];
let shop: Project;
let blog: Project;

function makeRouter(config: Partial<RouterConfig> = {}) {
  return new Router(
    {
      store,
      bus,
      questions,
      classifier,
      startSession,
      messenger,
      folders,
      timers,
      log: (m) => logs.push(m),
    },
    config,
  );
}

beforeEach(() => {
  clock = new FakeClock('2026-10-18T09:00:00.000Z');
  timers = new FakeTimers(clock);
  store = openStore({ clock });
  bus = new QuestionBus({
    onListenerError: (error) => {
      throw error;
    },
  });
  questions = new QuestionService(store, bus);
  requests = new RequestService(store, bus);
  sweeper = new DeadlineSweeper(questions, { timers });
  classifier = new FakeClassifier();
  messenger = new FakeMessenger();
  folders = new FakeFolderSessions(store);
  startSession = fakeStartSession(store);
  logs = [];
  shop = store.projects.create({ name: 'shop', markedForDirectInput: true });
  blog = store.projects.create({ name: 'blog', markedForDirectInput: true });
  router = makeRouter();
});

afterEach(async () => {
  await router.stop();
  sweeper.stop();
  store.close();
});

/** Lets pending promise callbacks run until `cond` holds. */
async function until(cond: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const routingQuestions = (): Question[] => {
  const session = findRouterSession(store);
  return session ? store.questions.list({ sessionId: session.id }) : [];
};
const noIdea = { projectId: null, target: { kind: 'new' }, confidence: 0, candidates: [] } as const;
const reservedDecisions = () => {
  const projectId = routerProjectId(store);
  return projectId === null ? [] : store.history.list({ projectId, kind: 'decision' });
};
const pendingQuestion = async (): Promise<Question> => {
  await until(() => routingQuestions().some((q) => q.status === 'pending'), 'a routing question');
  return routingQuestions().find((q) => q.status === 'pending')!;
};
const confident = (
  projectId: number,
  target: ClassifierOutput['target'],
  confidence = 0.9,
): ClassifierOutput => ({
  projectId,
  target,
  confidence,
  candidates: [],
  reason: 'matches the project',
});
const openSession = (project: Project, title: string) =>
  store.sessions.create({
    projectId: project.id,
    title,
    model: 'opus',
    branch: `loop/${title.replace(/ /g, '-')}`,
  });
const decisions = (project: Project) => store.history.list({ projectId: project.id, kind: 'decision' });

describe('confident classifications', () => {
  it('starts a new session in the chosen project and records the decision', async () => {
    classifier.answer = confident(shop.id, { kind: 'new' });
    void router.start();
    const request = requests.create({ text: 'Add a checkout page', source: 'telegram' });
    await until(() => store.requests.require(request.id).sessionId !== null, 'routing');
    await router.idle();

    expect(startSession.started).toHaveLength(1);
    const routed = store.requests.require(request.id);
    expect(routed.projectId).toBe(shop.id);
    expect(routed.sessionId).toBe(startSession.started[0]!.id);
    expect(messenger.delivered).toEqual([]);
    expect(routingQuestions()).toEqual([]);
    // Recorded after a successful launch, with the new session.
    const [decision] = decisions(shop);
    expect(decision?.sessionId).toBe(routed.sessionId);
    expect(decision?.text).toContain(`to shop: a new session #${routed.sessionId} ('Add a checkout page')`);
    expect(decision?.text).toContain(`Routed request #${request.id}`);
    expect(decision?.text).toContain('Classifier, 90% sure');
    expect(store.history.search('checkout', { projectId: shop.id })).toHaveLength(1);
  });

  it('delivers to an open session as a file plus a fixed sentence, never the text itself', async () => {
    const login = openSession(shop, 'fix login');
    classifier.answer = confident(shop.id, { kind: 'session', sessionId: login.id });
    void router.start();
    const request = requests.create({ text: 'Also handle expired tokens', source: 'telegram' });
    await until(() => store.requests.require(request.id).sessionId !== null, 'routing');

    const name = `request-${request.id}.md`;
    expect(messenger.delivered).toEqual([
      {
        sessionId: login.id,
        name,
        content: `# Request #${request.id} (from telegram, ${request.createdAt})\n\nAlso handle expired tokens\n`,
        sentence: deliverySentence(name),
      },
    ]);
    expect(deliverySentence(name)).toBe(
      `A new request from the human was routed to this session. Read the file .loop/${name} and handle that request.`,
    );
    expect(startSession.started).toEqual([]);
    expect(store.requests.require(request.id)).toMatchObject({ projectId: shop.id, sessionId: login.id });
    expect(decisions(shop)[0]?.text).toContain(`session 'fix login' (#${login.id})`);
  });

  it('shows the classifier the marked projects, their open sessions and recent requests', async () => {
    store.projects.update(shop.id, {
      repos: [{ name: 'web', path: '/w', remote: 'git@x:web.git', defaultBranch: 'main' }],
    });
    const login = openSession(shop, 'fix login');
    const old = openSession(shop, 'old');
    store.sessions.end(old.id);
    store.requests.create({
      text: 'Earlier task\nwith details',
      source: 'dashboard',
      projectId: shop.id,
      sessionId: login.id,
    });
    store.projects.create({ name: 'secret', markedForDirectInput: false });
    classifier.answer = confident(shop.id, { kind: 'new' });
    const request = requests.create({ text: 'Something', source: 'telegram' });
    await router.route(request.id);

    const input = classifier.inputs[0]!;
    expect(input.request).toEqual({ id: request.id, text: 'Something' });
    expect(input.projects.map((p) => p.name)).toEqual(['blog', 'shop']);
    expect(input.projects[1]).toEqual({
      id: shop.id,
      name: 'shop',
      kind: 'git',
      repos: ['web'],
      recentRequests: ['Earlier task'],
      sessions: [{ id: login.id, title: 'fix login', branch: 'loop/fix-login', status: 'active' }],
    });
  });

  it('starts a new session when the chosen session cannot take the request', async () => {
    const login = openSession(shop, 'fix login');
    classifier.answer = confident(shop.id, { kind: 'session', sessionId: login.id });
    messenger.fail = new Error('session is paused');
    const request = requests.create({ text: 'More login work', source: 'telegram' });
    const outcome = await router.route(request.id);

    expect(outcome).toMatchObject({ status: 'routed', newSession: true });
    expect(startSession.started).toHaveLength(1);
    expect(decisions(shop)[0]?.text).toContain('could not take it (session is paused)');
  });
});

describe('a request that names its project', () => {
  it('skips the classifier and gets a new session there, marked or not', async () => {
    const private_ = store.projects.create({ name: 'private', markedForDirectInput: false });
    openSession(private_, 'existing work');
    void router.start();
    const request = requests.create({
      text: 'Fix deploy failure of PR #3',
      source: 'dashboard',
      projectId: private_.id,
    });
    await until(() => store.requests.require(request.id).sessionId !== null, 'routing');

    expect(classifier.inputs).toEqual([]);
    expect(startSession.started.map((s) => s.projectId)).toEqual([private_.id]);
    expect(decisions(private_)[0]?.text).toContain('The request named its project.');
  });

  it('delivers a request addressed to one session there, skipping the classifier', async () => {
    const private_ = store.projects.create({ name: 'private', markedForDirectInput: false });
    openSession(private_, 'other work');
    const voice = openSession(private_, 'voice cloning');
    const request = requests.create({
      text: 'Try a lower sample rate',
      source: 'dashboard',
      projectId: private_.id,
      targetSessionId: voice.id,
    });
    const outcome = await router.route(request.id);

    expect(outcome).toEqual({
      status: 'routed',
      projectId: private_.id,
      sessionId: voice.id,
      newSession: false,
    });
    expect(classifier.inputs).toEqual([]);
    expect(startSession.started).toEqual([]);
    expect(messenger.delivered.map((d) => d.sessionId)).toEqual([voice.id]);
    expect(store.requests.require(request.id)).toMatchObject({
      sessionId: voice.id,
      targetSessionId: voice.id,
    });
  });

  it('resumes a paused session it is addressed to, even one the human paused, instead of starting another', async () => {
    const voice = store.sessions.create({
      projectId: shop.id,
      title: 'voice cloning',
      model: 'opus',
      branch: 'loop/voice',
      status: 'paused',
      pauseReason: 'manual',
    });
    const request = requests.create({
      text: 'Lower the pitch',
      source: 'dashboard',
      projectId: shop.id,
      targetSessionId: voice.id,
    });
    const outcome = await router.route(request.id);

    expect(outcome).toMatchObject({ status: 'routed', sessionId: voice.id, newSession: false });
    expect(folders.resumed.map((r) => r.sessionId)).toEqual([voice.id]);
    expect(messenger.delivered).toEqual([]);
    expect(startSession.started).toEqual([]);
    expect(decisions(shop)[0]?.text).toContain('The human addressed it to this session.');
  });

  it('relaunches an addressed git session whose agent exited, keeping its branch and conversation', async () => {
    const voice = store.sessions.create({
      projectId: shop.id,
      title: 'voice cloning',
      model: 'opus',
      branch: 'loop/voice',
      status: 'paused',
      pauseReason: 'agent_exited',
    });
    const request = requests.create({
      text: 'Carry on',
      source: 'dashboard',
      projectId: shop.id,
      targetSessionId: voice.id,
    });
    const outcome = await router.route(request.id);

    expect(outcome).toMatchObject({ status: 'routed', sessionId: voice.id, newSession: false });
    expect(folders.resumed.map((r) => r.sessionId)).toEqual([voice.id]);
    expect(startSession.started).toEqual([]);
  });

  it('gives a request for a session that has ended since a new session in that project', async () => {
    const voice = openSession(shop, 'voice cloning');
    const request = requests.create({
      text: 'One more take',
      source: 'dashboard',
      projectId: shop.id,
      targetSessionId: voice.id,
    });
    store.sessions.update(voice.id, { status: 'ended' });
    const outcome = await router.route(request.id);

    expect(outcome).toMatchObject({ status: 'routed', projectId: shop.id, newSession: true });
    expect(messenger.delivered).toEqual([]);
    expect(decisions(shop)[0]?.text).toContain(`Session #${voice.id} is no longer open`);
  });
});

describe('unclear classifications', () => {
  it('asks with the likely destinations, then routes on the answer', async () => {
    const login = openSession(shop, 'fix login');
    classifier.answer = {
      projectId: shop.id,
      target: { kind: 'session', sessionId: login.id },
      confidence: 0.5,
      candidates: [{ projectId: blog.id, target: { kind: 'new' }, confidence: 0.3 }],
      reason: 'could be either',
    } satisfies ClassifierOutput;
    void router.start();
    const request = requests.create({ text: 'Make the header smaller', source: 'telegram' });
    const question = await pendingQuestion();

    expect(question.text).toMatch(new RegExp(`^Route request #${request.id}: `));
    expect(question.text).toContain('Make the header smaller');
    expect(question.context).toBe(
      'From telegram. Not routed automatically: the classifier is only 50% sure (could be either).',
    );
    expect(question.requestId).toBe(request.id);
    expect(question.options).toEqual([
      `shop: session 'fix login' (#${login.id})`,
      'blog: new session',
      'shop: new session',
      CANCEL_OPTION,
    ]);
    expect(question.recommendedOption).toBe(`shop: session 'fix login' (#${login.id})`);
    expect(store.requests.require(request.id).sessionId).toBeNull();

    questions.answer(question.id, 'blog: new session', 'telegram');
    await until(() => store.requests.require(request.id).sessionId !== null, 'routing');
    expect(startSession.started.map((s) => s.projectId)).toEqual([blog.id]);
    expect(decisions(blog)[0]?.text).toContain(
      `The human chose "blog: new session" (question #${question.id}, via telegram)`,
    );
  });

  it('takes the recommended option when nobody answers in 15 minutes', async () => {
    const login = openSession(shop, 'fix login');
    classifier.answer = { ...confident(shop.id, { kind: 'session', sessionId: login.id }), confidence: 0.6 };
    sweeper.start();
    void router.start();
    const request = requests.create({ text: 'Tweak the login copy', source: 'telegram' });
    const question = await pendingQuestion();

    timers.advance(QUESTION_TIMEOUT_MS);
    await until(() => store.requests.require(request.id).sessionId !== null, 'routing');
    expect(store.questions.require(question.id).status).toBe('defaulted');
    expect(messenger.delivered.map((m) => m.sessionId)).toEqual([login.id]);
    expect(decisions(shop)[0]?.text).toContain('No answer to question');
  });

  it('accepts a free-text answer naming a project', async () => {
    classifier.answer = noIdea;
    const request = requests.create({ text: 'Do the thing', source: 'telegram' });
    const routing = router.route(request.id);
    const question = await pendingQuestion();
    questions.answer(question.id, '  BLOG ', 'telegram');
    expect(await routing).toMatchObject({ status: 'routed', projectId: blog.id, newSession: true });
  });

  it('asks again once when the answer matches nothing, then gives up', async () => {
    classifier.answer = noIdea;
    const request = requests.create({ text: 'Do the thing', source: 'telegram' });
    const routing = router.route(request.id);
    questions.answer((await pendingQuestion()).id, 'no idea', 'telegram');
    await until(() => routingQuestions().length === 2, 'the second question');
    const second = routingQuestions()[0]!;
    expect(second.text).toMatch(new RegExp(`^Route request #${request.id} \\(asked again\\)`));
    expect(second.context).toContain('"no idea" did not match an option');
    questions.answer(second.id, 'still no idea', 'dashboard');

    expect(await routing).toEqual({ status: 'unrouted', reason: 'answer "still no idea" matched no option' });
    expect(routingQuestions()).toHaveLength(2);
    // A later start does not ask a third time.
    expect(await router.route(request.id)).toMatchObject({ status: 'unrouted' });
    expect(routingQuestions()).toHaveLength(2);
  });

  it('leaves a cancelled request unrouted for good', async () => {
    classifier.answer = noIdea;
    const request = requests.create({ text: 'Never mind', source: 'telegram' });
    const routing = router.route(request.id);
    questions.answer((await pendingQuestion()).id, CANCEL_OPTION, 'dashboard');
    expect(await routing).toEqual({ status: 'cancelled' });

    expect(await makeRouter().route(request.id)).toEqual({ status: 'cancelled' });
    expect(routingQuestions()).toHaveLength(1);
    expect(classifier.inputs).toHaveLength(1);
    expect(store.requests.require(request.id)).toMatchObject({ projectId: null, sessionId: null });
    // Recorded once, in the reserved project, and left out of later scans.
    expect(reservedDecisions().map((d) => d.text)).toEqual([
      expect.stringContaining(`Cancelled request #${request.id}: the human chose "Cancel"`),
    ]);
    expect(await makeRouter().routePending()).toEqual([]);
  });

  it('offers at most 10 options, Cancel included', async () => {
    for (let i = 0; i < 6; i++) {
      const p = store.projects.create({ name: `p${i}`, markedForDirectInput: true });
      openSession(p, `work ${i}`);
    }
    classifier.answer = noIdea;
    const request = requests.create({ text: 'Anything', source: 'telegram' });
    void router.route(request.id);
    const question = await pendingQuestion();
    expect(question.options).toHaveLength(10);
    expect(question.options.at(-1)).toBe(CANCEL_OPTION);
    expect(question.options.slice(0, 8).every((o) => o.endsWith(': new session'))).toBe(true);
  });
});

describe('invalid classifier output counts as unclear', () => {
  const cases: [string, () => unknown][] = [
    ['not an object', () => 'shop, new session'],
    ['undefined (no JSON)', () => undefined],
    ['an unknown project id', () => confident(9999, { kind: 'new' })],
    [
      'a project not marked for direct input',
      () => confident(store.projects.create({ name: 'x' }).id, { kind: 'new' }),
    ],
    ['an unknown session id', () => confident(shop.id, { kind: 'session', sessionId: 9999 })],
    [
      'a session of another project',
      () => confident(blog.id, { kind: 'session', sessionId: openSession(shop, 's').id }),
    ],
    [
      'an ended session',
      () => {
        const s = openSession(shop, 'done');
        store.sessions.end(s.id);
        return confident(shop.id, { kind: 'session', sessionId: s.id });
      },
    ],
    // A valid destination with a bad confidence is still a proposal: it is offered and recommended.
    ['a confidence above 1', () => confident(shop.id, { kind: 'new' }, 1.5)],
    ['a confidence that is a string', () => ({ ...confident(shop.id, { kind: 'new' }), confidence: '0.9' })],
    ['an unknown target kind', () => ({ ...confident(shop.id, { kind: 'new' }), target: { kind: 'other' } })],
    ['the router project', () => confident(ensureRouterSession(store).projectId, { kind: 'new' })],
  ];

  it.each(cases)('%s', async (name, make) => {
    classifier.answer = make();
    const request = requests.create({ text: 'Classify me', source: 'telegram' });
    void router.route(request.id);
    const question = await pendingQuestion();
    expect(startSession.started).toEqual([]);
    expect(messenger.delivered).toEqual([]);
    const proposedShop = name.startsWith('a confidence');
    expect(question.recommendedOption).toBe(proposedShop ? 'shop: new session' : CANCEL_OPTION);
    expect(question.options).toContain('shop: new session');
    expect(question.options).toContain('blog: new session');
  });

  it('a classifier that throws', async () => {
    classifier.answer = () => {
      throw new Error('boom');
    };
    const request = requests.create({ text: 'Classify me', source: 'telegram' });
    void router.route(request.id);
    const question = await pendingQuestion();
    expect(question.context).toContain('the classifier failed');
    expect(logs.some((l) => l.includes('boom'))).toBe(true);
  });

  it('a classifier that times out', async () => {
    classifier.answer = () => new Promise(() => undefined); // never settles, ignores its signal
    let aborted = false;
    const slow = classifier.answer as () => Promise<never>;
    classifier.answer = (_input: unknown, signal: AbortSignal) => {
      signal.addEventListener('abort', () => (aborted = true));
      return slow();
    };
    router = makeRouter({ classifierTimeoutMs: 30_000 });
    const request = requests.create({ text: 'Classify me', source: 'telegram' });
    void router.route(request.id);
    await until(() => classifier.inputs.length === 1, 'the classifier call');
    timers.advance(29_999);
    await new Promise((resolve) => setImmediate(resolve));
    expect(routingQuestions()).toEqual([]);
    timers.advance(1);
    const question = await pendingQuestion();
    expect(question.context).toContain('the classifier timed out');
    expect(aborted).toBe(true);
  });
});

describe('no marked projects', () => {
  it('leaves the request unrouted without asking', async () => {
    store.projects.update(shop.id, { markedForDirectInput: false });
    store.projects.update(blog.id, { markedForDirectInput: false });
    const request = requests.create({ text: 'Where does this go?', source: 'telegram' });
    expect(await router.route(request.id)).toEqual({
      status: 'unrouted',
      reason: 'no project is marked for direct input',
    });
    expect(classifier.inputs).toEqual([]);
    expect(routingQuestions()).toEqual([]);
    expect(logs.join('\n')).toContain('no project is marked for direct input');
  });
});

describe('start-up and idempotency', () => {
  it('routes requests stored while no router ran: unrouted ones and ones with a project but no session', async () => {
    const unrouted = store.requests.create({ text: 'From Telegram while down', source: 'telegram' });
    const preset = store.requests.create({ text: 'Dashboard task', source: 'dashboard', projectId: blog.id });
    const login = openSession(shop, 'fix login');
    const done = store.requests.create({
      text: 'Done',
      source: 'dashboard',
      projectId: shop.id,
      sessionId: login.id,
    });
    classifier.answer = confident(shop.id, { kind: 'new' });

    const outcomes = await router.start();
    expect(outcomes).toHaveLength(2);
    expect(store.requests.require(unrouted.id).projectId).toBe(shop.id);
    expect(store.requests.require(preset.id).projectId).toBe(blog.id);
    expect(startSession.started).toHaveLength(2);
    expect(store.requests.require(done.id).sessionId).toBe(login.id);
    expect(classifier.inputs.map((i) => i.request.id)).toEqual([unrouted.id]);
  });

  it('re-attaches to a routing question left pending by a previous run instead of asking again', async () => {
    classifier.answer = noIdea;
    const request = requests.create({ text: 'Asked before a restart', source: 'telegram' });
    void router.route(request.id);
    const question = await pendingQuestion();
    await router.stop();
    expect(store.requests.require(request.id).sessionId).toBeNull();

    router = makeRouter();
    const scan = router.start();
    await new Promise((resolve) => setImmediate(resolve));
    questions.answer(question.id, 'shop: new session', 'dashboard');
    await scan;
    expect(routingQuestions()).toHaveLength(1);
    expect(classifier.inputs).toHaveLength(1);
    expect(store.requests.require(request.id).projectId).toBe(shop.id);
  });

  it('applies an answer given while the router was down', async () => {
    classifier.answer = noIdea;
    const request = requests.create({ text: 'Answered while down', source: 'telegram' });
    void router.route(request.id);
    const question = await pendingQuestion();
    await router.stop();
    questions.answer(question.id, 'blog: new session', 'telegram');

    router = makeRouter();
    await router.start();
    expect(store.requests.require(request.id).projectId).toBe(blog.id);
    expect(startSession.started).toHaveLength(1);
  });

  it('gives one session when the start-up scan and the creation event fire for the same request', async () => {
    const request = store.requests.create({
      text: 'Fix deploy failure',
      source: 'dashboard',
      projectId: shop.id,
    });
    const scan = router.start();
    bus.emit({ type: 'request.created', request });
    await scan;
    await router.idle();
    expect(startSession.started).toHaveLength(1);
    expect(store.sessions.list({ projectId: shop.id })).toHaveLength(1);
    expect(store.requests.require(request.id).sessionId).toBe(startSession.started[0]!.id);
  });

  it('routes a request once, however often it is triggered', async () => {
    classifier.answer = confident(shop.id, { kind: 'new' });
    void router.start();
    const request = requests.create({ text: 'Once only', source: 'telegram' });
    bus.emit({ type: 'request.created', request });
    const [a, b] = await Promise.all([router.route(request.id), router.route(request.id)]);
    expect(a).toBe(b);
    await router.idle();
    expect(startSession.started).toHaveLength(1);
    expect(classifier.inputs).toHaveLength(1);
    expect(await router.route(request.id)).toEqual({ status: 'skipped', reason: 'already routed' });
    expect(await router.routePending()).toEqual([]);
    expect(decisions(shop)).toHaveLength(1);
  });

  it('keeps the project when a session cannot start, so the next start retries', async () => {
    classifier.answer = confident(shop.id, { kind: 'new' });
    const failing = Object.assign(() => Promise.reject(new Error('no repos')), { started: [] });
    router = new Router({
      store,
      bus,
      questions,
      classifier,
      startSession: failing,
      messenger,
      timers,
      log: (m) => logs.push(m),
    });
    const request = requests.create({ text: 'Will fail first', source: 'telegram' });
    expect(await router.route(request.id)).toEqual({
      status: 'unrouted',
      reason: 'could not start a session: no repos',
    });
    expect(store.requests.require(request.id)).toMatchObject({ projectId: shop.id, sessionId: null });

    router = makeRouter();
    await router.start();
    expect(store.requests.require(request.id).sessionId).toBe(startSession.started[0]!.id);
    expect(classifier.inputs).toHaveLength(1);
  });

  it('creates its reserved project and session once, ended and not marked', () => {
    const a = ensureRouterSession(store);
    const b = ensureRouterSession(store);
    expect(a.id).toBe(b.id);
    expect(a.status).toBe('ended');
    expect(store.projects.require(a.projectId)).toMatchObject({
      name: ROUTER_PROJECT_NAME,
      markedForDirectInput: false,
    });
    expect(store.settings.getRouterSessionId()).toBe(a.id);
  });

  it('finds its reserved project by id: a rename keeps it, a user project with its name is left alone', () => {
    const mine = store.projects.create({ name: ROUTER_PROJECT_NAME, markedForDirectInput: true });
    const reserved = ensureRouterSession(store);
    expect(reserved.projectId).not.toBe(mine.id);
    expect(store.projects.require(reserved.projectId).name).toBe(`${ROUTER_PROJECT_NAME} 2`);
    store.projects.update(reserved.projectId, { name: 'renamed' });
    expect(ensureRouterSession(store).id).toBe(reserved.id);
    expect(routerProjectId(store)).toBe(reserved.projectId);
  });

  it('makes a new reserved session if the old one was deleted', () => {
    const first = ensureRouterSession(store);
    store.projects.delete(first.projectId);
    expect(findRouterSession(store)).toBeUndefined();
    const second = ensureRouterSession(store);
    expect(second.id).not.toBe(first.id);
  });

  it('stops listening after stop()', async () => {
    classifier.answer = confident(shop.id, { kind: 'new' });
    void router.start();
    await router.stop();
    requests.create({ text: 'After stop', source: 'telegram' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(classifier.inputs).toEqual([]);
  });
});

describe('the default when nobody answers', () => {
  it('is Cancel when the classifier proposed nothing, so no session starts by default', async () => {
    classifier.answer = noIdea;
    sweeper.start();
    const request = requests.create({ text: 'Who knows', source: 'telegram' });
    const routing = router.route(request.id);
    const question = await pendingQuestion();
    expect(question.recommendedOption).toBe(CANCEL_OPTION);
    timers.advance(QUESTION_TIMEOUT_MS);
    expect(await routing).toEqual({ status: 'cancelled' });
    expect(startSession.started).toEqual([]);
    expect(reservedDecisions()[0]?.text).toContain(`Cancelled request #${request.id}: no answer to question`);
  });

  it('is the top candidate when the classifier proposed one', async () => {
    classifier.answer = {
      ...noIdea,
      candidates: [{ projectId: blog.id, target: { kind: 'new' }, confidence: 0.4 }],
    };
    sweeper.start();
    const request = requests.create({ text: 'Probably the blog', source: 'telegram' });
    const routing = router.route(request.id);
    expect((await pendingQuestion()).recommendedOption).toBe('blog: new session');
    timers.advance(QUESTION_TIMEOUT_MS);
    expect(await routing).toMatchObject({ status: 'routed', projectId: blog.id, newSession: true });
  });

  it('is Cancel on a re-ask, whatever the first question recommended', async () => {
    classifier.answer = {
      ...noIdea,
      candidates: [{ projectId: blog.id, target: { kind: 'new' }, confidence: 0.4 }],
    };
    const request = requests.create({ text: 'Probably the blog', source: 'telegram' });
    void router.route(request.id);
    questions.answer((await pendingQuestion()).id, 'hmm', 'telegram');
    await until(() => routingQuestions().length === 2, 'the second question');
    expect(routingQuestions()[0]!.recommendedOption).toBe(CANCEL_OPTION);
  });
});

describe('the reserved project', () => {
  it('refuses a request that names it', async () => {
    const reserved = ensureRouterSession(store);
    const request = store.requests.create({
      text: 'Sneaky',
      source: 'dashboard',
      projectId: reserved.projectId,
    });
    expect(await router.route(request.id)).toEqual({
      status: 'unrouted',
      reason: 'the request names the reserved router project',
    });
    expect(startSession.started).toEqual([]);
  });

  it('ignores questions in its session that are not tied to a request', async () => {
    const reserved = ensureRouterSession(store);
    questions.ask({
      sessionId: reserved.id,
      text: 'Route request #1: looks like one, but has no request link',
      options: ['shop: new session', CANCEL_OPTION],
      recommendedOption: CANCEL_OPTION,
    });
    classifier.answer = confident(shop.id, { kind: 'new' });
    const request = requests.create({ text: 'Real request', source: 'telegram' });
    expect(request.id).toBe(1);
    expect(await router.route(request.id)).toMatchObject({ status: 'routed', projectId: shop.id });
  });
});

describe('a failed start', () => {
  it('is recorded as its own entry, and the routing decision only after a launch that worked', async () => {
    let fail = true;
    const flaky = (projectId: number, request: { requestId: number }) =>
      fail ? Promise.reject(new Error('no repos')) : startSession(projectId, request);
    router = new Router({ store, bus, questions, classifier, startSession: flaky, messenger, timers });
    const request = store.requests.create({ text: 'Flaky start', source: 'dashboard', projectId: shop.id });
    expect(await router.route(request.id)).toMatchObject({ status: 'unrouted' });
    expect(decisions(shop).map((d) => d.text)).toEqual([
      expect.stringMatching(
        new RegExp(`^Could not start a session for request #${request.id} .*: no repos\\.`),
      ),
    ]);

    fail = false;
    expect(await router.route(request.id)).toMatchObject({ status: 'routed', newSession: true });
    expect(decisions(shop)[0]?.text).toMatch(new RegExp(`^Routed request #${request.id} `));
    expect(decisions(shop)[0]?.sessionId).toBe(store.requests.require(request.id).sessionId);
  });

  it('never attaches a request to a session that merely looks like its own', async () => {
    const request = store.requests.create({ text: 'Half started', source: 'dashboard', projectId: shop.id });
    openSession(shop, 'Half started'); // e.g. left half-started by a crash: nothing may drive it
    expect(await router.route(request.id)).toMatchObject({ status: 'routed', newSession: true });
    expect(startSession.started).toHaveLength(1);
    expect(store.requests.require(request.id).sessionId).toBe(startSession.started[0]!.id);
  });
});

describe('start-up backlog', () => {
  it('starts at most `concurrency` sessions at once', async () => {
    let running = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const slow = Object.assign(
      async (projectId: number, request: { requestId: number }) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => release.push(resolve));
        running--;
        return startSession(projectId, request);
      },
      { started: [] },
    );
    for (let i = 0; i < 5; i++) {
      store.requests.create({ text: `Backlog ${i}`, source: 'dashboard', projectId: shop.id });
    }
    router = new Router(
      { store, bus, questions, classifier, startSession: slow, messenger, timers, log: (m) => logs.push(m) },
      { concurrency: 2 },
    );
    const scan = router.start();
    for (let done = 0; done < 5; done++) {
      await until(() => release.length > 0, 'a started session');
      expect(running).toBeLessThanOrEqual(2);
      release.shift()!();
    }
    expect(await scan).toHaveLength(5);
    expect(peak).toBe(2);
    expect(startSession.started).toHaveLength(5);
  });
});

describe('rescan', () => {
  it('logs "no marked project" once per scan, not once per request', async () => {
    store.projects.update(shop.id, { markedForDirectInput: false });
    store.projects.update(blog.id, { markedForDirectInput: false });
    for (let i = 0; i < 3; i++) store.requests.create({ text: `Waiting ${i}`, source: 'telegram' });
    await router.start();
    timers.advance(5 * 60_000);
    await router.idle();
    await new Promise((resolve) => setImmediate(resolve));
    const lines = logs.filter((l) => l.includes('no project is marked'));
    expect(lines).toEqual([
      '[router] 3 request(s) not routed: no project is marked for direct input',
      '[router] 3 request(s) not routed: no project is marked for direct input',
    ]);
  });

  it('routes a waiting request once a project is marked, without a restart', async () => {
    store.projects.update(shop.id, { markedForDirectInput: false });
    store.projects.update(blog.id, { markedForDirectInput: false });
    classifier.answer = confident(shop.id, { kind: 'new' });
    void router.start();
    const request = requests.create({ text: 'Waiting for a marked project', source: 'telegram' });
    await router.idle();
    expect(store.requests.require(request.id).sessionId).toBeNull();

    store.projects.update(shop.id, { markedForDirectInput: true });
    timers.advance(5 * 60_000);
    await until(() => store.requests.require(request.id).sessionId !== null, 'routing on rescan');
    expect(store.requests.require(request.id).projectId).toBe(shop.id);
  });

  it('does not retry failed starts (requests with a project) on the rescan, only on start', async () => {
    let calls = 0;
    const counting = () => {
      calls++;
      return Promise.reject(new Error('no repos'));
    };
    router = new Router({ store, bus, questions, classifier, startSession: counting, messenger, timers });
    store.requests.create({ text: 'Fails', source: 'dashboard', projectId: shop.id });
    await router.start();
    expect(calls).toBe(1);
    timers.advance(15 * 60_000);
    await router.idle();
    expect(calls).toBe(1);
  });
});

describe('folder projects', () => {
  let resume: Project;
  beforeEach(() => {
    resume = store.projects.create({
      name: 'cv',
      kind: 'folder',
      folderPath: '/home/me/resume',
      markedForDirectInput: true,
    });
  });
  const decisionsOf = (p: Project) => store.history.list({ projectId: p.id, kind: 'decision' });
  const openFolderSession = (extra: { status?: 'paused'; pauseReason?: PauseReason } = {}) =>
    store.sessions.create({
      projectId: resume.id,
      title: 'resume work',
      model: 'opus',
      branch: '',
      ...extra,
    });
  const named = (text: string) => store.requests.create({ text, source: 'dashboard', projectId: resume.id });

  it('are eligible, and the classifier sees their kind and folder name (not the full path)', async () => {
    classifier.answer = confident(resume.id, { kind: 'new' });
    const request = requests.create({ text: 'Update my resume', source: 'telegram' });
    const outcome = await router.route(request.id);
    expect(outcome).toMatchObject({ status: 'routed', projectId: resume.id, newSession: true });
    const shown = classifier.inputs[0]!.projects.find((p) => p.id === resume.id);
    expect(shown).toEqual({
      id: resume.id,
      name: 'cv',
      kind: 'folder',
      folder: 'resume',
      repos: [],
      recentRequests: [],
      sessions: [],
    });
    expect(JSON.stringify(classifier.inputs[0])).not.toContain('/home/me');
    expect(classifier.inputs[0]!.projects.find((p) => p.id === shop.id)).not.toHaveProperty('folder');
  });

  it('still validates classifier output: an unknown id is unclear, not routed', async () => {
    classifier.answer = confident(999, { kind: 'new' });
    const request = requests.create({ text: 'Update my resume', source: 'telegram' });
    void router.route(request.id);
    const q = await pendingQuestion();
    expect(q.requestId).toBe(request.id);
    expect(startSession.started).toEqual([]);
  });

  it('a request needing a new session goes to the live open session instead', async () => {
    const open = openFolderSession();
    const request = named('Rewrite the summary');
    expect(await router.route(request.id)).toEqual({
      status: 'routed',
      projectId: resume.id,
      sessionId: open.id,
      newSession: false,
    });
    expect(messenger.delivered.map((d) => [d.sessionId, d.name])).toEqual([
      [open.id, `request-${request.id}.md`],
    ]);
    expect(startSession.started).toEqual([]);
    expect(store.requests.require(request.id).sessionId).toBe(open.id);
    expect(decisionsOf(resume)[0]?.text).toContain(
      'a folder runs one session at a time, so it was delivered',
    );
  });

  it.each(['usage_limit'] as const)(
    'resumes a session paused automatically (%s) and hands it the request',
    async (reason) => {
      const open = openFolderSession({ status: 'paused', pauseReason: reason });
      const request = named('Fix the dates');
      expect(await router.route(request.id)).toMatchObject({
        status: 'routed',
        sessionId: open.id,
        newSession: false,
      });
      expect(folders.resumed).toEqual([
        {
          sessionId: open.id,
          name: `request-${request.id}.md`,
          content: expect.stringContaining('Fix the dates') as unknown,
          sentence: deliverySentence(`request-${request.id}.md`),
        },
      ]);
      expect(messenger.delivered).toEqual([]);
      expect(decisionsOf(resume)[0]?.text).toContain('resumed the paused session');
    },
  );

  it('ends a dead session (agent exited, or active with no live agent) and starts a fresh one', async () => {
    const exited = openFolderSession({ status: 'paused', pauseReason: 'agent_exited' });
    const first = named('One');
    expect(await router.route(first.id)).toMatchObject({ status: 'routed', newSession: true });
    expect(store.sessions.require(exited.id).status).toBe('ended');
    expect(folders.calls).toEqual([`state ${exited.id}`, `end ${exited.id}`]);
    expect(decisionsOf(resume)[0]?.text).toContain(`Ended session #${exited.id} first`);

    const halfStarted = startSession.started[0]!;
    folders.states.set(halfStarted.id, 'dead');
    const second = named('Two');
    expect(await router.route(second.id)).toMatchObject({ status: 'routed', newSession: true });
    expect(store.sessions.require(halfStarted.id).status).toBe('ended');
    expect(startSession.started).toHaveLength(2);
  });

  it('when the chosen session cannot take it, the folder flow handles it, never a second agent', async () => {
    const open = openFolderSession();
    classifier.answer = confident(resume.id, { kind: 'session', sessionId: open.id });
    messenger.fail = new Error('agent gone');
    folders.states.set(open.id, 'live');
    const request = requests.create({ text: 'Fix the dates', source: 'telegram' });
    void router.route(request.id);
    // Every delivery fails: after the attempts, the human is asked (once), Cancel being the default.
    const q = await pendingQuestion();
    expect(q.options).toEqual([`cv: new session`, `cv: session 'resume work' (#${open.id})`, 'Cancel']);
    expect(q.recommendedOption).toBe('Cancel');
    expect(q.text).toContain('could not be delivered');
    expect(startSession.started).toEqual([]);
    questions.answer(q.id, 'Cancel', 'dashboard');
    await router.idle();
    expect(await router.route(request.id)).toEqual({ status: 'cancelled' });
    // Settled: the scans leave it alone.
    expect((await router.routePending()).filter((o) => o.status !== 'skipped')).toEqual([]);
  });

  it('a lost start race (FolderBusyError) goes round again and delivers to the winner', async () => {
    let calls = 0;
    const racing = (projectId: number) => {
      calls++;
      // Another request's session got in first.
      const winner = openFolderSession();
      return Promise.reject(new FolderBusyError(projectId, winner.id));
    };
    router = new Router({
      store,
      bus,
      questions,
      classifier,
      startSession: racing,
      messenger,
      folders,
      timers,
    });
    const request = named('Race');
    const outcome = await router.route(request.id);
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({ status: 'routed', newSession: false });
    expect(messenger.delivered).toHaveLength(1);
  });

  it('a request waiting on a busy-folder question after a restart waits for its answer', async () => {
    messenger.fail = new Error('agent gone');
    const open = openFolderSession();
    folders.states.set(open.id, 'live');
    const request = named('Fix the dates');
    void router.route(request.id);
    const q = await pendingQuestion();
    await router.stop();
    messenger.fail = null;
    router = makeRouter();
    void router.route(request.id);
    await new Promise((resolve) => setImmediate(resolve));
    expect(routingQuestions()).toHaveLength(1); // no second question
    questions.answer(q.id, `cv: session 'resume work' (#${open.id})`, 'dashboard');
    await until(() => store.requests.require(request.id).sessionId === open.id, 'delivery after the answer');
  });

  describe('a session the human paused', () => {
    const manualQuestion = async () => {
      const q = await pendingQuestion();
      expect(q.options).toEqual([RESUME_AND_DELIVER, END_AND_START_FRESH, 'Cancel']);
      expect(q.recommendedOption).toBe('Cancel');
      expect(q.text).toContain('Cancel (the default, if no one answers) drops this request');
      return q;
    };

    it('is never resumed on its own: the human is asked, and Resume delivers into it', async () => {
      const open = openFolderSession({ status: 'paused', pauseReason: 'manual' });
      const request = named('Fix the dates');
      const outcome = router.route(request.id);
      const q = await manualQuestion();
      expect(folders.resumed).toEqual([]);
      expect(store.sessions.require(open.id).status).toBe('paused');
      questions.answer(q.id, RESUME_AND_DELIVER, 'dashboard');
      expect(await outcome).toMatchObject({ status: 'routed', sessionId: open.id, newSession: false });
      expect(folders.resumed.map((r) => r.sessionId)).toEqual([open.id]);
      expect(decisionsOf(resume)[0]?.text).toContain('resumed as asked');
    });

    it('End it and start fresh ends the paused session and starts a new one', async () => {
      const open = openFolderSession({ status: 'paused', pauseReason: 'manual' });
      const request = named('Fix the dates');
      const outcome = router.route(request.id);
      questions.answer((await manualQuestion()).id, END_AND_START_FRESH, 'dashboard');
      expect(await outcome).toMatchObject({ status: 'routed', newSession: true });
      expect(store.sessions.require(open.id).status).toBe('ended');
      expect(folders.resumed).toEqual([]);
    });

    it('no answer: Cancel (the default) drops the request and settles it', async () => {
      const open = openFolderSession({ status: 'paused', pauseReason: 'manual' });
      const request = named('Fix the dates');
      const outcome = router.route(request.id);
      await manualQuestion();
      sweeper.start();
      timers.advance(QUESTION_TIMEOUT_MS);
      expect(await outcome).toEqual({ status: 'cancelled' });
      expect(store.sessions.require(open.id).status).toBe('paused');
      expect(store.requests.require(request.id).sessionId).toBeNull();
      expect(await router.route(request.id)).toEqual({ status: 'cancelled' });
    });
  });

  describe('waiting for the human never holds a routing slot', () => {
    const stuckFolder = (name: string) => {
      const p = store.projects.create({
        name,
        kind: 'folder',
        folderPath: `/home/me/${name}`,
        markedForDirectInput: true,
      });
      const s = store.sessions.create({ projectId: p.id, title: `${name} work`, model: 'opus', branch: '' });
      folders.states.set(s.id, 'live');
      return p;
    };

    it("two busy-folder questions answered with a destination don't freeze routing (reviewer's case)", async () => {
      messenger.fail = new Error('agent gone');
      const a = stuckFolder('notes');
      const b = stuckFolder('letters');
      const r1 = store.requests.create({ text: 'one', source: 'dashboard', projectId: a.id });
      const r2 = store.requests.create({ text: 'two', source: 'dashboard', projectId: b.id });
      const p1 = router.route(r1.id);
      const p2 = router.route(r2.id);
      await until(
        () => routingQuestions().filter((q) => q.status === 'pending').length === 2,
        'two questions',
      );
      for (const q of routingQuestions().filter((x) => x.status === 'pending')) {
        expect(q.options[0]).toMatch(/: new session$/);
        questions.answer(q.id, q.options[0]!, 'dashboard');
      }
      // An unrelated git-project request arrives meanwhile and still routes.
      classifier.answer = confident(shop.id, { kind: 'new' });
      const r3 = requests.create({ text: 'three', source: 'telegram' });
      expect(await router.route(r3.id)).toMatchObject({
        status: 'routed',
        projectId: shop.id,
        newSession: true,
      });
      // The answered ones finish too (still busy: unrouted, not deadlocked).
      const outcomes = await Promise.all([p1, p2]);
      expect(outcomes.map((o) => o.status)).toEqual(['unrouted', 'unrouted']);
      await router.idle();
    });

    it('more pending questions than slots: other requests keep routing', async () => {
      router = makeRouter({ concurrency: 1 });
      const pending: Promise<unknown>[] = [];
      for (const name of ['f1', 'f2', 'f3']) {
        const p = store.projects.create({ name, kind: 'folder', folderPath: `/home/me/${name}` });
        store.sessions.create({
          projectId: p.id,
          title: `${name} work`,
          model: 'opus',
          branch: '',
          status: 'paused',
          pauseReason: 'manual',
        });
        pending.push(
          router.route(store.requests.create({ text: name, source: 'dashboard', projectId: p.id }).id),
        );
      }
      await until(
        () => routingQuestions().filter((q) => q.status === 'pending').length === 3,
        'three questions',
      );
      classifier.answer = confident(shop.id, { kind: 'new' });
      const other = requests.create({ text: 'unrelated', source: 'telegram' });
      expect(await router.route(other.id)).toMatchObject({ status: 'routed', projectId: shop.id });
      // Answering with a destination re-takes the single slot without deadlock.
      for (const q of routingQuestions().filter((x) => x.status === 'pending'))
        questions.answer(q.id, RESUME_AND_DELIVER, 'dashboard');
      const outcomes = (await Promise.all(pending)) as { status: string }[];
      expect(outcomes.map((o) => o.status)).toEqual(['routed', 'routed', 'routed']);
    });
  });
});

const TWO_GAMES = [
  { title: 'Coin Run', task: 'Make the hero clearer in Coin Run' },
  { title: 'Rocket Race', task: 'Longer track in Rocket Race' },
];

/** A planner that splits "games" requests, asks `ask` for requests containing "ambiguous", else one task. */
function planner(calls: string[], ask = 'Which catalog do you mean?') {
  return {
    plan: (text: string) => {
      calls.push(text);
      if (text.includes('Clarification from human')) return Promise.resolve({ parts: [], question: ask });
      if (text.includes('ambiguous')) return Promise.resolve({ parts: [], question: ask });
      return Promise.resolve({ parts: text.includes('games') ? TWO_GAMES : [], question: null });
    },
  };
}

const makePlanRouter = (
  splitter: { plan(text: string): Promise<Plan> },
  config: Partial<RouterConfig> = {},
) =>
  new Router(
    {
      store,
      bus,
      questions,
      classifier,
      startSession,
      messenger,
      folders,
      timers,
      log: (m) => logs.push(m),
      splitter,
    },
    { planTimeoutMs: 1000, ...config },
  );

const planQuestions = () => store.questions.list({}).filter((q) => q.text.startsWith('[plan-stage]'));

describe('splitting into parts', () => {
  it('gives each independent part its own session without asking the human, and never routes the parent again', async () => {
    const splits: string[] = [];
    router = makePlanRouter(planner(splits));
    const whole = requests.create({
      text: 'Two games: Coin Run and Rocket Race',
      source: 'dashboard',
      projectId: shop.id,
    });
    const outcome = await router.route(whole.id);

    expect(outcome).toMatchObject({ status: 'split', projectId: shop.id });
    expect(planQuestions()).toHaveLength(0);
    const parts = store.requests.parts(whole.id);
    expect(parts.map((p) => p.text.split('\n')[0])).toEqual([
      'Make the hero clearer in Coin Run',
      'Longer track in Rocket Race',
    ]);
    expect(parts.every((p) => p.sessionId !== null && p.text.includes('part'))).toBe(true);
    expect(new Set(parts.map((p) => p.sessionId)).size).toBe(2);
    expect(store.requests.require(whole.id).sessionId).toBeNull();
    // Parts are never split again, and a later scan leaves the parent alone.
    expect(splits).toHaveLength(1);
    await router.routePending();
    expect(startSession.started).toHaveLength(2);

    const single = requests.create({ text: 'Fix the login button', source: 'dashboard', projectId: shop.id });
    expect(await router.route(single.id)).toMatchObject({ status: 'routed', newSession: true });
    // A simple request starts its session right away, with no question.
    expect(planQuestions()).toHaveLength(0);
    // The PR loop's own requests (a deploy fix quotes the original multi-part request) stay whole.
    const fix = requests.create({
      text: '[loop] Fix deploy failure of PR #3: Original request: Two games',
      source: 'dashboard',
      projectId: shop.id,
    });
    expect(await router.route(fix.id)).toMatchObject({ status: 'routed', newSession: true });
    expect(splits).toHaveLength(2); // the login fix was planned; the loop's request never was
  });

  it('splits several requests at once under concurrency: 1 without deadlock', async () => {
    router = makePlanRouter(planner([]), { concurrency: 1 });
    const ids = [1, 2].map(
      (n) => requests.create({ text: `Two games (${n})`, source: 'dashboard', projectId: shop.id }).id,
    );
    const outcomes = await Promise.all(ids.map((id) => router.route(id)));
    expect(outcomes.map((o) => o.status)).toEqual(['split', 'split']);
    expect(startSession.started).toHaveLength(4);
  });
});

describe('Plan stage', () => {
  it('asks only when the planner has a real question, and plans again with the answer', async () => {
    const calls: string[] = [];
    router = makePlanRouter({
      plan: (text: string) => {
        calls.push(text);
        return Promise.resolve(
          text.includes('Clarification from human')
            ? { parts: TWO_GAMES, question: null }
            : { parts: [], question: 'Which catalog: spring or fall?' },
        );
      },
    });
    const whole = requests.create({ text: 'Fix the catalog', source: 'dashboard', projectId: shop.id });
    const routing = router.route(whole.id);
    const planQuestion = await pendingQuestion();
    expect(planQuestion.text).toContain('Which catalog: spring or fall?');
    expect(planQuestion.text).not.toContain('parallel');

    questions.answer(planQuestion.id, 'The spring catalog', 'dashboard');
    expect(await routing).toMatchObject({ status: 'split', projectId: shop.id });
    expect(store.requests.parts(whole.id)).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('Clarification from human (Plan stage):');
    expect(calls[1]).toContain('The spring catalog');
  });

  it('asks one question per request: a second question from the planner is ignored', async () => {
    const calls: string[] = [];
    router = makePlanRouter(planner(calls));
    const whole = requests.create({ text: 'An ambiguous thing', source: 'dashboard', projectId: shop.id });
    const routing = router.route(whole.id);
    questions.answer((await pendingQuestion()).id, 'The login page', 'dashboard');
    expect(await routing).toMatchObject({ status: 'routed', newSession: true });
    expect(planQuestions()).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('proceeds on the planner’s own judgment when the question times out', async () => {
    sweeper.start();
    router = makePlanRouter(planner([]));
    const whole = requests.create({ text: 'An ambiguous thing', source: 'dashboard', projectId: shop.id });
    const routing = router.route(whole.id);
    const planQuestion = await pendingQuestion();
    timers.advance(1000);
    await until(() => store.questions.require(planQuestion.id).status === 'defaulted', 'defaulted');
    expect(await routing).toMatchObject({ status: 'routed', newSession: true });
    expect(store.requests.require(whole.id).text).toBe('An ambiguous thing');
  });

  it('never asks when planTimeoutMs is 0', async () => {
    router = makePlanRouter(planner([]), { planTimeoutMs: 0 });
    const whole = requests.create({ text: 'An ambiguous thing', source: 'dashboard', projectId: shop.id });
    expect(await router.route(whole.id)).toMatchObject({ status: 'routed', newSession: true });
    expect(planQuestions()).toHaveLength(0);
  });
});
