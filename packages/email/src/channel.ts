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
import type {
  EmailMessage,
  EmailThread,
  PullRequest,
  Question,
  Request,
  Store,
} from '@loop-engineering/core';
import { allowed, replyText, type IncomingMail, type Mailbox } from './mail.js';

/*
 * The email channel. A task mailed by an allowlisted, authenticated sender starts a thread: the
 * clarifier asks the questions it needs (answered by reply) until it has a plan, the plan goes back
 * on the thread as approved, and its request starts the work. From then on the thread carries the
 * agents' questions (a reply answers them), messages to the session (any other reply), and a note
 * when each of its PRs is in production. Once all of that work is done, a reply starts a new round.
 * The PR loop's own decisions (merge, deploy, revert) stay with the owner: they never go by email.
 */

/** One mail of the conversation, as the clarifier reads it. */
export interface ClarifyMail {
  from: 'requester' | 'loop';
  text: string;
}

/** Turns a mailed task into questions, a plan, or (in a new round) nothing new: the router's CliClassifier. */
export interface Clarifier {
  clarify(
    mails: ClarifyMail[],
    options: { mustPlan: boolean; earlier?: string | null },
    signal: AbortSignal,
  ): Promise<{ questions: string[] } | { plan: string } | { nothing: true }>;
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
  /** How long one clarifier call may take. Default 5 minutes. */
  clarifyTimeoutMs?: number;
  log?: (message: string) => void;
}

/** After this many rounds of questions the clarifier must write the plan. */
const QUESTION_ROUNDS = 2;
/** A clarifier that keeps failing on a thread: the task starts without a plan after this many tries. */
const CLARIFY_TRIES = 3;
/** New threads, and mails on one thread, taken per hour: a flood of mail (or a looping robot) stops there. */
const NEW_THREADS_PER_HOUR = 10;
const MAILS_PER_THREAD_PER_HOUR = 30;
const MAX_REQUEST_CHARS = 20_000;
/** A request still unrouted after this long had its routing cancelled (its question defaulted). */
const ROUTING_MS = 30 * 60_000;
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
    // A round stuck past the abort (a mailbox that never answers) must not hold up the server's stop.
    await Promise.race([this.running, new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
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
        await this.receive(mail);
      } catch (err) {
        this.log(`[email] could not take mail ${mail.messageId}: ${(err as Error).message}`);
      }
    }
    store.email.setCursor(mailbox.address, cursor);
    for (const thread of store.email.threads({ state: 'clarifying' })) await this.clarify(thread);
    for (const thread of store.email.threads({ state: 'building' })) await this.sendQuestions(thread);
    // Clarifying threads too: a PR of an earlier round can ship while a new round asks its questions.
    for (const thread of store.email.threads()) await this.sendReleaseNotes(thread);
  }

  // ------------------------------------------------------------------ incoming mail

  private async receive(mail: IncomingMail): Promise<void> {
    const { store, mailbox, allowlist } = this.o;
    if (mail.from === mailbox.address.toLowerCase() || mail.automatic) return;
    if (!allowed(mail.from, allowlist))
      return this.log(`[email] ignored mail from ${mail.from}: not on the allowlist`);
    if (!mail.authenticated)
      return this.log(`[email] ignored mail from ${mail.from}: Gmail did not authenticate its sender`);
    if (store.email.messageByMessageId(mail.messageId)) return; // read before
    const since = store.clock.now().getTime() - HOUR;
    const recent = (m: { createdAt: string }) => Date.parse(m.createdAt) > since;

    const thread = this.threadOf(mail);
    if (!thread) {
      // A new task: its whole body (a forwarded mail included), else its subject.
      const text = mail.text.trim() || mail.subject.trim();
      if (!text) return;
      if (store.email.threads().filter(recent).length >= NEW_THREADS_PER_HOUR)
        return this.log(
          `[email] ignored a new task from ${mail.from}: ${NEW_THREADS_PER_HOUR} this hour already`,
        );
      const created = store.email.createThread({
        sender: mail.from,
        subject: mail.subject.replace(/^(re|fwd?):\s*/i, '').trim() || 'Your task',
        mailThreadId: mail.threadId,
      });
      store.email.addMessage({ threadId: created.id, messageId: mail.messageId, direction: 'in', text });
      this.log(`[email] new task from ${mail.from}: "${created.subject}"`);
      return;
    }
    const text = replyText(mail.text);
    if (!text) return; // a reply with nothing new in it
    const incoming = store.email.messages(thread.id).filter((m) => m.direction === 'in' && recent(m));
    if (incoming.length >= MAILS_PER_THREAD_PER_HOUR)
      return this.log(
        `[email] ignored a reply on "${thread.subject}": ${MAILS_PER_THREAD_PER_HOUR} this hour already`,
      );
    const message = store.email.addMessage({
      threadId: thread.id,
      messageId: mail.messageId,
      direction: 'in',
      text,
    });
    if (thread.state === 'building') await this.onReply(thread, mail, message);
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

  /**
   * A reply while the thread has work: the answer to a question asked here, a message for its
   * session, or, once all of its work is done, a new round.
   */
  private async onReply(thread: EmailThread, mail: IncomingMail, message: EmailMessage): Promise<void> {
    const { store, questions, requests } = this.o;
    const question = this.questionAnswered(thread, mail, message.text);
    if (question) {
      store.email.setMessageQuestion(message.id, question.id);
      questions.answer(question.id, answerFor(question, message.text), 'email');
      return;
    }
    const session = this.sessionsOf(thread)
      .filter((s) => s.status !== 'ended')
      .at(-1);
    if (session) {
      const request = requests.create({
        text: message.text,
        source: 'email',
        projectId: session.projectId,
        targetSessionId: session.id,
      });
      store.email.setMessageRequest(message.id, request.id);
      return;
    }
    if (this.done(thread)) {
      store.email.updateThread(thread.id, { state: 'clarifying' });
      return;
    }
    const note = this.starting(thread)
      ? 'The work on this is still being set up. Please send this again once it has started.'
      : "The work on this is still finishing (being checked, merged or deployed). I'll write here when it's in production; reply after that to ask for anything new.";
    // Said once an hour at most, however many replies come in meanwhile.
    const since = store.clock.now().getTime() - HOUR;
    const said = store.email
      .messages(thread.id)
      .some((m) => m.text === note && Date.parse(m.createdAt) > since);
    if (!said) await this.reply(thread, note);
    // The note asks for it again later: a new round does not read it.
    store.email.updateThread(thread.id, { roundAfter: message.id });
  }

  /**
   * The pending question a reply answers: the one its mail replies to, or, when one question is
   * open on the thread, that one if the reply reads as an answer (an option's number or words).
   */
  private questionAnswered(thread: EmailThread, mail: IncomingMail, text: string): Question | undefined {
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
    return open.length === 1 && pickedOption(open[0]!, text) !== undefined ? open[0] : undefined;
  }

  // ------------------------------------------------------------------ clarifying

  /**
   * A clarifying thread whose last mail is the requester's: questions back, or the plan and the
   * work. A new round on a finished thread sees only its own mails, with the earlier plan as context.
   */
  private async clarify(thread: EmailThread): Promise<void> {
    const { store, clarifier } = this.o;
    const all = store.email.messages(thread.id);
    if (all.at(-1)?.direction !== 'in') return;
    // What earlier rounds started (each plan, each reply passed to a session): context, not new asks.
    const started = all.filter((m) => m.requestId !== null);
    const earlier = started.length === 0 ? null : started.map((m) => m.text).join('\n\n---\n\n');
    // This round: the requester's new mails and the questions asked about them, nothing already dealt with.
    const mails = all.filter(
      (m) =>
        m.id > thread.roundAfter &&
        m.questionId === null &&
        m.requestId === null &&
        (m.direction === 'in' || m.text.startsWith(QUESTIONS_INTRO)),
    );
    const conversation = mails.map(
      (m) => ({ from: m.direction === 'in' ? 'requester' : 'loop', text: m.text }) as const,
    );
    const rounds = mails.filter((m) => m.direction === 'out' && m.text.startsWith(QUESTIONS_INTRO)).length;
    let answer: Awaited<ReturnType<Clarifier['clarify']>> | null;
    try {
      const timeout = AbortSignal.timeout(this.o.clarifyTimeoutMs ?? 5 * 60_000);
      answer = await clarifier.clarify(
        conversation,
        { mustPlan: rounds >= QUESTION_ROUNDS, earlier },
        AbortSignal.any([this.abort.signal, timeout]),
      );
      const usable =
        answer !== null &&
        typeof answer === 'object' &&
        (('questions' in answer &&
          Array.isArray(answer.questions) &&
          answer.questions.length > 0 &&
          answer.questions.every((q) => typeof q === 'string')) ||
          ('plan' in answer && typeof answer.plan === 'string' && answer.plan.trim() !== '') ||
          ('nothing' in answer && earlier !== null));
      if (!usable) throw new Error('the clarifier answered with nothing usable');
    } catch (err) {
      if (this.abort.signal.aborted) return;
      const tries = (this.clarifyFailures.get(thread.id) ?? 0) + 1;
      this.clarifyFailures.set(thread.id, tries);
      this.log(`[email] could not plan "${thread.subject}" (try ${tries}): ${(err as Error).message}`);
      if (tries < CLARIFY_TRIES) return;
      answer = null; // start without a plan rather than never
    }
    if (answer && 'nothing' in answer) {
      // A thank-you or the like: no new work, and no reply to it.
      this.clarifyFailures.delete(thread.id);
      store.email.updateThread(thread.id, { state: 'building', roundAfter: all.at(-1)!.id });
      return;
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
    const sent = await this.reply(thread, body);
    if (!sent) return; // tried again next round
    store.transaction(() => {
      const request = this.o.requests.create({
        text: requestText(thread, conversation, plan, earlier),
        source: 'email',
      });
      store.email.setMessageRequest(sent.id, request.id);
      store.email.updateThread(thread.id, { state: 'building', requestId: request.id, roundAfter: sent.id });
      this.log(`[email] "${thread.subject}" became request ${request.id}`);
    });
    this.clarifyFailures.delete(thread.id);
  }

  // ------------------------------------------------------------------ while building

  /** Every request the thread started (each round's plan, each reply passed on) and their parts. */
  private requestsOf(thread: EmailThread): Request[] {
    const { requests, email } = this.o.store;
    const ids = new Set(
      email.messages(thread.id).flatMap((m) => (m.requestId === null ? [] : [m.requestId])),
    );
    if (thread.requestId !== null) ids.add(thread.requestId);
    return [...ids].flatMap((id) => {
      const root = requests.get(id);
      return root ? [root, ...requests.parts(id)] : [];
    });
  }

  /** The sessions working on the thread's requests, oldest first. */
  private sessionsOf(thread: EmailThread) {
    const { sessions } = this.o.store;
    const ids = new Set(this.requestsOf(thread).flatMap((r) => [r.sessionId, r.targetSessionId]));
    return [...ids]
      .filter((id): id is number => id !== null)
      .sort((a, b) => a - b)
      .flatMap((id) => sessions.get(id) ?? []);
  }

  private prsOf(thread: EmailThread): PullRequest[] {
    const ids = new Set(this.requestsOf(thread).map((r) => r.id));
    return this.o.store.pullRequests.list().filter((pr) => pr.requestId !== null && ids.has(pr.requestId));
  }

  /**
   * A request of the thread that has no session yet and may still get one: the router has it, or
   * is starting its session. Unrouted after ROUTING_MS, its routing was cancelled.
   */
  private starting(thread: EmailThread): boolean {
    const routing = this.o.store.clock.now().getTime() - ROUTING_MS;
    return this.requestsOf(thread).some(
      (r) => r.sessionId === null && r.targetSessionId === null && Date.parse(r.createdAt) > routing,
    );
  }

  /**
   * All of the thread's work is over: nothing still starting, no session open, no PR still in the
   * loop or being deployed, and none of its questions waiting.
   */
  private done(thread: EmailThread): boolean {
    const { store } = this.o;
    if (this.starting(thread)) return false;
    if (this.sessionsOf(thread).some((s) => s.status !== 'ended')) return false;
    if (this.prsOf(thread).some((pr) => pr.outcome === null || pr.stage === 'deploying')) return false;
    return !store.questions.list({ status: 'pending' }).some((q) => this.belongsTo(q, thread));
  }

  /**
   * A question for the thread's requester: an agent's (ask_human) or the router's, about the
   * thread's work. The system's questions (the PR loop's merge and deploy decisions, the Guardian,
   * the server) are the owner's and never count, even when asked in the thread's session.
   */
  private belongsTo(question: Question, thread: EmailThread): boolean {
    if (question.origin === 'system') return false;
    const requests = this.requestsOf(thread);
    if (question.requestId !== null && requests.some((r) => r.id === question.requestId)) return true;
    const sessions = new Set(requests.flatMap((r) => [r.sessionId, r.targetSessionId]));
    return (
      question.origin === 'agent' &&
      sessions.has(question.sessionId) &&
      question.createdAt >= thread.createdAt
    );
  }

  /** Emails the thread's pending questions it has not asked yet (also a retry after a failed send). */
  private async sendQuestions(thread: EmailThread): Promise<void> {
    const { store } = this.o;
    for (const q of store.questions.list({ status: 'pending' })) {
      if (this.asking.has(q.id) || store.email.messageForQuestion(q.id)) continue;
      if (!this.belongsTo(q, thread)) continue;
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

  /** On the thread, once per PR it started: in production, merged, reverted, or stopped. */
  private async sendReleaseNotes(thread: EmailThread): Promise<void> {
    const told = new Set(this.o.store.email.messages(thread.id).map((m) => m.prId));
    for (const pr of this.prsOf(thread)) {
      if (told.has(pr.id)) continue;
      const note = releaseNote(pr);
      if (note) await this.reply(thread, note, { prId: pr.id });
    }
  }

  // ------------------------------------------------------------------ the question bus

  onQuestion(question: Question): void {
    const thread = this.o.store.email.threads({ state: 'building' }).find((t) => this.belongsTo(question, t));
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
  ): Promise<EmailMessage | null> {
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
      return null;
    }
    return store.email.addMessage({ threadId: thread.id, messageId, direction: 'out', text, ...link });
  }
}

const QUESTIONS_INTRO = 'Thanks! A few questions before I start:';
const WHILE_BUILDING =
  "If the agents need anything, they'll ask here, and I'll write here again when the new version is in production. Reply to this email at any time to add to the task.";

/** The request the work starts from: what was asked (and built before, in a new round), then the plan. */
function requestText(
  thread: EmailThread,
  conversation: ClarifyMail[],
  plan: string | null,
  earlier: string | null,
): string {
  const head = earlier
    ? `A follow-up by email from ${thread.sender} ("${thread.subject}"). Already built earlier, not to redo:\n${clip(earlier, 3000)}`
    : `Task from ${thread.sender} by email ("${thread.subject}"):`;
  const tail = plan ? `The plan sent back to them as approved:\n${plan}` : '';
  const mails = conversation
    .map((m) => `${m.from === 'requester' ? 'Requester' : 'Loop'}:\n${m.text}`)
    .join('\n\n');
  // The plan and the start of the task always fit; a long conversation loses its middle.
  const room = MAX_REQUEST_CHARS - head.length - tail.length - 10;
  const body = mails.length <= room ? mails : `${mails.slice(0, room / 2)}\n[…]\n${mails.slice(-room / 2)}`;
  return [head, body, tail].filter(Boolean).join('\n\n');
}

/** What the requester hears about a finished PR, or null while there is nothing to say. */
function releaseNote(pr: PullRequest): string | null {
  const name = `${pr.repo}#${pr.number} (${pr.url})`;
  if (pr.stage === 'deployed') return `The new version is in production: ${name} is merged and deployed.`;
  if (pr.outcome === 'merged' && pr.stage === 'merge')
    return `${name} is merged into the main branch, and ships with its next deploy.`;
  if (pr.outcome === 'reverted')
    return `${name} was merged, but its deploy failed, so it was reverted. The loop is fixing it in a new PR.`;
  if (pr.outcome === 'escalated')
    return `${name} is stopped: it needs a decision from the owner before it can go on.`;
  if (pr.outcome === 'closed') return `${name} was closed without merging.`;
  return null;
}

/** The option a reply picks: by its number on the first line, or by its words. */
function pickedOption(question: Question, text: string): string | undefined {
  const first = text.split('\n')[0]!.trim();
  const n = /^(\d+)[.)]?$/.exec(first)?.[1];
  if (n && Number(n) >= 1 && Number(n) <= question.options.length) return question.options[Number(n) - 1];
  return question.options.find((o) => o.toLowerCase() === text.trim().toLowerCase());
}

/** A reply as an answer: the option it picks, else its own words. */
export function answerFor(question: Question, text: string): string {
  return pickedOption(question, text) ?? text.trim().slice(0, QUESTION_LIMITS.answer);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
