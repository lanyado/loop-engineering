import { randomUUID } from 'node:crypto';
import {
  QUESTION_LIMITS,
  attachChannel,
  type QuestionBus,
  type QuestionChannel,
  type QuestionResolvedEvent,
  type QuestionService,
  type RequestService,
  type Unsubscribe,
} from '@loop-engineering/ask-human';
import type { EmailMessage, EmailThread, PullRequest, Question, Store } from '@loop-engineering/core';
import { allowed, replyText, type IncomingMail, type Mailbox } from './mail.js';

/*
 * The email channel. A task mailed by an allowlisted, authenticated sender starts a thread: the
 * clarifier asks the questions it needs (answered by reply) until it has a plan, the plan goes back
 * on the thread as approved, and its request starts the work. From then on the thread carries the
 * agents' questions (a reply answers them), messages to the session (any other reply), and a note
 * when each of its PRs is in production. Everything happens on the one thread, in its order.
 */

/** One mail of the conversation, as the clarifier reads it. */
export interface ClarifyMail {
  from: 'requester' | 'loop';
  text: string;
}

/** Turns a mailed task into questions for the requester or a plan (the router's CliClassifier). */
export interface Clarifier {
  clarify(
    mails: ClarifyMail[],
    mustPlan: boolean,
    signal: AbortSignal,
  ): Promise<{ questions: string[] } | { plan: string }>;
}

export interface EmailChannelOptions {
  mailbox: Mailbox;
  store: Store;
  questions: QuestionService;
  requests: RequestService;
  bus: QuestionBus;
  clarifier: Clarifier;
  /** Who may send tasks: exact addresses, or "@domain". */
  allowlist: readonly string[];
  /** How often the inbox is read (start()). */
  pollMs: number;
  log?: (message: string) => void;
}

/** After this many rounds of questions the clarifier must write the plan. */
const QUESTION_ROUNDS = 2;
/** A clarifier that keeps failing on a thread: the task starts without a plan after this many tries. */
const CLARIFY_TRIES = 3;
/** New threads accepted per hour, so a flood of mail cannot start a flood of sessions. */
const NEW_THREADS_PER_HOUR = 10;
const MAX_REQUEST_CHARS = 20_000;
const HOUR = 3_600_000;

export class EmailChannel implements QuestionChannel {
  readonly name = 'email' as const;
  private readonly log: (message: string) => void;
  private detach: Unsubscribe | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private readonly clarifyFailures = new Map<number, number>();
  /** Questions being emailed now: the bus and the poll may both reach one at the same moment. */
  private readonly asking = new Set<number>();
  private readonly abort = new AbortController();
  private lastError: string | null = null;

  constructor(private readonly o: EmailChannelOptions) {
    this.log = o.log ?? console.log;
  }

  /** Listens to the question bus and reads the inbox every pollMs. */
  start(): void {
    this.detach = attachChannel(this.o.bus, this);
    const tick = () => {
      void this.poll().finally(() => {
        if (!this.abort.signal.aborted) this.timer = setTimeout(tick, this.o.pollMs);
      });
    };
    tick();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.detach?.();
    await this.running;
    await this.o.mailbox.close();
  }

  /** One round: read new mail, move each thread on, email what is waiting. Never throws. */
  poll(): Promise<void> {
    this.running ??= this.round()
      .then(() => {
        this.lastError = null;
      })
      .catch((err: unknown) => {
        // A mailbox that stays down is logged once, not every round.
        const message = (err as Error).message;
        if (message !== this.lastError) this.log(`[email] ${message}`);
        this.lastError = message;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async round(): Promise<void> {
    const { store, mailbox } = this.o;
    const { mails, cursor } = await mailbox.fetch(store.email.cursor(mailbox.address));
    for (const mail of mails) {
      try {
        this.receive(mail);
      } catch (err) {
        this.log(`[email] could not take mail ${mail.messageId}: ${(err as Error).message}`);
      }
    }
    store.email.setCursor(mailbox.address, cursor);
    for (const thread of store.email.threads({ state: 'clarifying' })) await this.clarify(thread);
    for (const thread of store.email.threads({ state: 'building' })) {
      await this.sendQuestions(thread);
      await this.sendReleaseNotes(thread);
    }
  }

  // ------------------------------------------------------------------ incoming mail

  private receive(mail: IncomingMail): void {
    const { store, mailbox, allowlist } = this.o;
    if (mail.from === mailbox.address.toLowerCase() || mail.automatic) return;
    if (!allowed(mail.from, allowlist))
      return this.log(`[email] ignored mail from ${mail.from}: not on the allowlist`);
    if (!mail.authenticated)
      return this.log(
        `[email] ignored mail from ${mail.from}: its domain did not authenticate it (DMARC/DKIM)`,
      );
    if (store.email.messageByMessageId(mail.messageId)) return; // read before
    const text = replyText(mail.text) || mail.subject.trim();
    if (!text) return;

    let thread = this.threadOf(mail);
    if (!thread) {
      const since = store.clock.now().getTime() - HOUR;
      if (store.email.threads().filter((t) => Date.parse(t.createdAt) > since).length >= NEW_THREADS_PER_HOUR)
        return this.log(
          `[email] ignored a new task from ${mail.from}: ${NEW_THREADS_PER_HOUR} tasks this hour already`,
        );
      thread = store.email.createThread({
        sender: mail.from,
        subject: mail.subject.replace(/^(re|fwd?):\s*/i, '').trim() || 'Your task',
        mailThreadId: mail.threadId,
      });
      this.log(`[email] new task from ${mail.from}: "${thread.subject}"`);
    }
    store.email.addMessage({ threadId: thread.id, messageId: mail.messageId, direction: 'in', text });
    if (thread.state === 'building') this.onReply(thread, mail, text);
    // A clarifying thread moves on in clarify(), which sees the reply as its last mail.
  }

  /** The thread a mail belongs to: by the provider's thread id, else by what it replies to. */
  private threadOf(mail: IncomingMail): EmailThread | undefined {
    const { email } = this.o.store;
    const byThreadId = mail.threadId ? email.threadByMailThreadId(mail.threadId) : undefined;
    if (byThreadId) return byThreadId;
    for (const id of [mail.inReplyTo, ...[...mail.references].reverse()]) {
      const known = id ? email.messageByMessageId(id) : undefined;
      if (known) return email.requireThread(known.threadId);
    }
    return undefined;
  }

  /** A reply while the work runs: the answer to a question asked here, or a message for the work. */
  private onReply(thread: EmailThread, mail: IncomingMail, text: string): void {
    const { store, questions, requests } = this.o;
    const question = this.questionAnswered(thread, mail);
    if (question) {
      questions.answer(question.id, answerFor(question, text), 'email');
      return;
    }
    const open = this.requestTree(thread)
      .flatMap((r) => [r.sessionId, r.targetSessionId])
      .filter((id): id is number => id !== null)
      .map((id) => store.sessions.get(id))
      .filter((s) => s !== undefined && s.status !== 'ended');
    const sessions = [...new Map(open.map((s) => [s!.id, s!])).values()];
    if (sessions.length > 0) {
      for (const s of sessions)
        requests.create({ text, source: 'email', projectId: s.projectId, targetSessionId: s.id });
      return;
    }
    const request = thread.requestId === null ? undefined : store.requests.get(thread.requestId);
    if (request?.projectId === null) {
      void this.reply(thread, 'The task is still being set up. Please send this again in a few minutes.');
      return;
    }
    // The work finished: a new reply is a new round on the same thread, with all of it as context.
    store.email.updateThread(thread.id, { state: 'clarifying' });
  }

  /** The pending question a reply answers: the one its mail replies to, else the only one open. */
  private questionAnswered(thread: EmailThread, mail: IncomingMail): Question | undefined {
    const { store } = this.o;
    const pending = (m: EmailMessage | undefined) => {
      const q = m?.questionId != null ? store.questions.get(m.questionId) : undefined;
      return q?.status === 'pending' ? q : undefined;
    };
    const direct = pending(mail.inReplyTo ? store.email.messageByMessageId(mail.inReplyTo) : undefined);
    if (direct) return direct;
    const open = store.email
      .messages(thread.id)
      .map(pending)
      .filter((q) => q !== undefined);
    return open.length === 1 ? open[0] : undefined;
  }

  // ------------------------------------------------------------------ clarifying

  /** A clarifying thread whose last mail is the requester's: questions back, or the plan and the work. */
  private async clarify(thread: EmailThread): Promise<void> {
    const { store, clarifier } = this.o;
    const mails = store.email.messages(thread.id);
    if (mails.at(-1)?.direction !== 'in') return;
    const conversation = mails.map(
      (m) => ({ from: m.direction === 'in' ? 'requester' : 'loop', text: m.text }) as const,
    );
    const rounds = mails.filter((m) => m.direction === 'out' && m.text.startsWith(QUESTIONS_INTRO)).length;
    let answer: { questions: string[] } | { plan: string } | null;
    try {
      answer = await clarifier.clarify(conversation, rounds >= QUESTION_ROUNDS, this.abort.signal);
    } catch (err) {
      const tries = (this.clarifyFailures.get(thread.id) ?? 0) + 1;
      this.clarifyFailures.set(thread.id, tries);
      this.log(`[email] could not plan "${thread.subject}" (try ${tries}): ${(err as Error).message}`);
      if (tries < CLARIFY_TRIES) return;
      answer = null; // start without a plan rather than never
    }
    if (answer && 'questions' in answer) {
      this.clarifyFailures.delete(thread.id);
      const list = answer.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
      await this.reply(thread, `${QUESTIONS_INTRO}\n\n${list}\n\nReply to this email with your answers.`);
      return;
    }
    const plan = answer?.plan ?? null;
    const body = plan
      ? `The plan is approved, and the work has started:\n\n${plan}\n\n${WHILE_BUILDING}`
      : `Got it: the work has started.\n\n${WHILE_BUILDING}`;
    if (!(await this.reply(thread, body))) return; // tried again next round
    const request = this.o.requests.create({
      text: requestText(thread, conversation, plan),
      source: 'email',
    });
    store.email.updateThread(thread.id, { state: 'building', requestId: request.id });
    this.clarifyFailures.delete(thread.id);
    this.log(`[email] "${thread.subject}" became request ${request.id}`);
  }

  // ------------------------------------------------------------------ while building

  /** The thread's request and the parts the router split it into. */
  private requestTree(thread: EmailThread) {
    const { requests } = this.o.store;
    const root = thread.requestId === null ? undefined : requests.get(thread.requestId);
    return root ? [root, ...requests.parts(root.id)] : [];
  }

  /** The building thread a question belongs to: asked about its request, by its sessions, or about its PRs. */
  private threadFor(question: Question): EmailThread | undefined {
    const { store } = this.o;
    const prOf = (q: Question) =>
      store.pullRequests
        .list({ open: true })
        .find((pr) => (pr.loopState as { question?: { id?: number } }).question?.id === q.id);
    const pr = prOf(question);
    return store.email.threads({ state: 'building' }).find((thread) => {
      const tree = this.requestTree(thread);
      const ids = new Set(tree.map((r) => r.id));
      const sessions = new Set(tree.flatMap((r) => [r.sessionId, r.targetSessionId]));
      return (
        (question.requestId !== null && ids.has(question.requestId)) ||
        (pr?.requestId != null && ids.has(pr.requestId)) ||
        (sessions.has(question.sessionId) && question.createdAt >= thread.createdAt)
      );
    });
  }

  /** Emails the thread's pending questions it has not asked yet (also a retry after a failed send). */
  private async sendQuestions(thread: EmailThread): Promise<void> {
    const { store } = this.o;
    for (const q of store.questions.list({ status: 'pending' })) {
      if (this.asking.has(q.id) || store.email.messageForQuestion(q.id)) continue;
      if (this.threadFor(q)?.id !== thread.id) continue;
      const options = q.options
        .map((o, i) => `${i + 1}. ${o}${o === q.recommendedOption ? ' (recommended)' : ''}`)
        .join('\n');
      const body = [
        'A question about your task:',
        q.text,
        q.context ?? '',
        `Options:\n${options}`,
        `Reply with a number or your own answer. With no answer by ${new Date(q.deadline).toUTCString()}, it goes with "${q.recommendedOption}".`,
      ]
        .filter(Boolean)
        .join('\n\n');
      this.asking.add(q.id);
      try {
        await this.reply(thread, body, { questionId: q.id });
      } finally {
        this.asking.delete(q.id);
      }
    }
  }

  /** On the thread, once per PR: in production, merged where nothing deploys, or reverted. */
  private async sendReleaseNotes(thread: EmailThread): Promise<void> {
    const { store } = this.o;
    const ids = new Set(this.requestTree(thread).map((r) => r.id));
    const told = new Set(store.email.messages(thread.id).map((m) => m.prId));
    for (const pr of store.pullRequests.list({ open: false })) {
      if (pr.requestId === null || !ids.has(pr.requestId) || told.has(pr.id)) continue;
      const note = releaseNote(pr);
      if (note) await this.reply(thread, note, { prId: pr.id });
    }
  }

  // ------------------------------------------------------------------ the question bus

  onQuestion(question: Question): void {
    const thread = this.threadFor(question);
    if (thread) void this.sendQuestions(thread);
  }

  onResolvedElsewhere(event: QuestionResolvedEvent, confirmation: string): void {
    const asked = this.o.store.email.messageForQuestion(event.question.id);
    if (!asked) return;
    const thread = this.o.store.email.requireThread(asked.threadId);
    void this.reply(thread, `The question "${clip(event.question.text, 120)}" is settled: ${confirmation}.`);
  }

  // ------------------------------------------------------------------ sending

  /** Sends on the thread (to its requester, threaded after its last mail) and records it. */
  private async reply(
    thread: EmailThread,
    text: string,
    link: { questionId?: number; prId?: number } = {},
  ): Promise<boolean> {
    const { store, mailbox } = this.o;
    const earlier = store.email.messages(thread.id).map((m) => m.messageId);
    const domain = mailbox.address.split('@')[1] ?? 'localhost';
    const messageId = `<loop-${randomUUID()}@${domain}>`;
    try {
      await mailbox.send({
        to: thread.sender,
        subject: `Re: ${thread.subject}`,
        text,
        messageId,
        ...(earlier.length > 0 ? { inReplyTo: earlier.at(-1)!, references: earlier.slice(-20) } : {}),
      });
    } catch (err) {
      this.log(`[email] could not send to ${thread.sender}: ${(err as Error).message}`);
      return false;
    }
    store.email.addMessage({ threadId: thread.id, messageId, direction: 'out', text, ...link });
    return true;
  }
}

const QUESTIONS_INTRO = 'Thanks! A few questions before I start:';
const WHILE_BUILDING =
  "If the agents need anything, they'll ask here, and I'll write here again when the new version is in production. Reply to this email at any time to add to the task.";

/** The request the work starts from: the whole conversation, then the plan. */
function requestText(thread: EmailThread, conversation: ClarifyMail[], plan: string | null): string {
  const mails = conversation
    .map((m) => `${m.from === 'requester' ? 'Requester' : 'Loop'}:\n${m.text}`)
    .join('\n\n');
  return [
    `Task from ${thread.sender} by email ("${thread.subject}"):`,
    mails,
    plan ? `The plan sent back to them as approved:\n${plan}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_REQUEST_CHARS);
}

/** What the requester hears about a finished PR, or null while there is nothing to say. */
function releaseNote(pr: PullRequest): string | null {
  const name = `${pr.repo}#${pr.number} (${pr.url})`;
  if (pr.stage === 'deployed') return `The new version is in production: ${name} is merged and deployed.`;
  if (pr.outcome === 'merged' && pr.stage === 'merge')
    return `${name} is merged into the main branch, and ships with its next deploy.`;
  if (pr.outcome === 'reverted')
    return `${name} was merged, but its deploy failed, so it was reverted. The loop is fixing it in a new PR.`;
  return null;
}

/** A reply as an answer: "2" picks the second option, an option's own words pick it, else the text. */
export function answerFor(question: Question, text: string): string {
  const first = text.split('\n')[0]!.trim();
  const n = /^(\d+)[.)]?$/.exec(first)?.[1];
  if (n && Number(n) >= 1 && Number(n) <= question.options.length) return question.options[Number(n) - 1]!;
  const same = question.options.find((o) => o.toLowerCase() === text.trim().toLowerCase());
  return same ?? text.trim().slice(0, QUESTION_LIMITS.answer);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
