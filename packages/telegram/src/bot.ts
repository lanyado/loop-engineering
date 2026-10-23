import {
  attachChannel,
  type QuestionBus,
  type QuestionChannel,
  type QuestionResolvedEvent,
  type QuestionService,
  type RequestService,
  type Unsubscribe,
} from '@loop-engineering/ask-human';
import { ValidationError, type Question, type Store } from '@loop-engineering/core';
import { AccessControl } from './access.js';
import {
  alreadySettledText,
  FOOTER_MARK,
  layoutQuestion,
  parseCallbackData,
  questionIdFromText,
  resolutionLine,
  resolvedText,
  stripFooter,
  truncate,
  type QuestionOrigin,
} from './format.js';
import type { CallbackQuery, Message, TelegramTransport, Update, User } from './transport.js';
import { TELEGRAM_LIMITS } from './transport.js';

export interface TelegramBotOptions {
  transport: TelegramTransport;
  store: Store;
  questions: QuestionService;
  /** Stores new tasks and emits request.created for the router. */
  requests: RequestService;
  bus: QuestionBus;
  /** TELEGRAM_OWNER_ID. */
  ownerId: number;
  /** IANA zone for deadlines, e.g. "Asia/Jerusalem". Default: the server's zone. */
  timeZone?: string;
  log?: (message: string) => void;
}

/** One recipient's copy of a question: the chat and the message holding the buttons. */
interface Post {
  chatId: number;
  messageId: number;
  /** Text to keep when the question is settled (the button message without its footer). */
  base: string;
}

/** How many message -> question links to remember for matching replies (oldest are dropped). */
const MAX_LINKS = 5000;
/** How many update ids to remember, to drop updates Telegram delivers twice (a poll that is retried). */
const MAX_SEEN_UPDATES = 1000;

const HELP =
  'Send me a task as a plain message and I will save it as a request for the router.\n' +
  'Answer a question by tapping an option, or reply to the question message with your own answer.\n\n' +
  '/status: pending questions and active sessions\n' +
  '/q<id>: show a pending question again, e.g. /q12';

/**
 * The Telegram side of Loop Engineering: posts ask_human questions to the owner and the allowlist,
 * takes answers from button taps and replies, stores other messages as new requests, and answers
 * /status. It sends nothing unprompted except questions and their "answered" confirmations.
 *
 * Message ids live in memory. After a restart, taps and replies on older question messages still
 * work (the callback data and the "Question #id" header carry the question id); only the edit of a
 * message that was answered elsewhere is skipped, and the confirmation is still sent.
 */
export class TelegramBot implements QuestionChannel {
  readonly name = 'telegram' as const;
  readonly access: AccessControl;
  private readonly transport: TelegramTransport;
  private readonly store: Store;
  private readonly questions: QuestionService;
  private readonly requests: RequestService;
  private readonly bus: QuestionBus;
  private readonly timeZone: string | undefined;
  private readonly log: (message: string) => void;
  /** question id -> one post per recipient chat. Dropped once the question is settled and edited. */
  private readonly posts = new Map<number, Post[]>();
  /** "chat:message" -> question id, for every message sent about a question (details included). */
  private readonly links = new Map<string, number>();
  /** Sends in flight per question, so a fast answer edits the messages only after they exist. */
  private readonly sending = new Map<number, Promise<void>>();
  /** Who tapped or replied, shown on the edited message. Set just before answering. */
  private readonly answeredBy = new Map<number, string>();
  /** Recent update ids, oldest first. */
  private readonly seenUpdates = new Set<number>();
  private detach: Unsubscribe | null = null;

  constructor(options: TelegramBotOptions) {
    this.transport = options.transport;
    this.store = options.store;
    this.questions = options.questions;
    this.requests = options.requests;
    this.bus = options.bus;
    this.timeZone = options.timeZone;
    this.log = options.log ?? console.log;
    this.access = new AccessControl({
      ownerId: options.ownerId,
      allowlist: () => this.store.settings.get().telegramAllowlist,
      clock: this.store.clock,
      log: this.log,
    });
  }

  /** Attaches to the question bus. Updates arrive through handleUpdate (long polling). */
  attach(): void {
    this.detach ??= attachChannel(this.bus, this);
  }

  /** Detaches from the bus and waits for sends in flight. */
  async close(): Promise<void> {
    this.detach?.();
    this.detach = null;
    await Promise.allSettled([...this.sending.values()]);
  }

  /**
   * Entry point for every update. Never throws: a failure is logged and the update dropped. An
   * update id seen before is ignored, so a redelivered update cannot store a task twice.
   */
  async handleUpdate(update: Update): Promise<void> {
    if (this.seenUpdates.has(update.update_id)) return;
    this.seenUpdates.add(update.update_id);
    if (this.seenUpdates.size > MAX_SEEN_UPDATES) {
      const oldest = this.seenUpdates.values().next().value;
      if (oldest !== undefined) this.seenUpdates.delete(oldest);
    }
    try {
      if (update.callback_query) await this.onCallback(update.callback_query);
      else if (update.message) await this.onMessage(update.message);
    } catch (error) {
      this.log(`[telegram] update ${update.update_id} failed: ${String(error)}`);
    }
  }

  // --- QuestionChannel -------------------------------------------------------------------------

  onQuestion(question: Question): Promise<void> {
    return this.track(
      question.id,
      Promise.all(this.access.recipients().map((chatId) => this.post(question, chatId))),
    );
  }

  async onResolvedHere(event: QuestionResolvedEvent): Promise<void> {
    const by = this.answeredBy.get(event.question.id);
    this.answeredBy.delete(event.question.id);
    await this.settle(event, resolutionLine(event, by));
  }

  async onResolvedElsewhere(event: QuestionResolvedEvent, confirmation: string): Promise<void> {
    const posts = await this.settle(event, resolutionLine(event));
    const chats: { chatId: number; messageId?: number }[] =
      posts.length > 0 ? posts : this.access.recipients().map((chatId) => ({ chatId }));
    // Without the original message (sent before a restart) the confirmation names the question.
    const text = posts.length > 0 ? confirmation : `Question #${event.question.id}: ${confirmation}`;
    await Promise.allSettled(
      chats.map((p) =>
        this.transport
          .sendMessage(p.chatId, truncate(text, TELEGRAM_LIMITS.text), {
            silent: true,
            ...(p.messageId === undefined ? {} : { replyTo: p.messageId }),
          })
          .catch((error: unknown) =>
            this.log(`[telegram] confirmation to ${p.chatId} failed: ${String(error)}`),
          ),
      ),
    );
  }

  // --- Questions -------------------------------------------------------------------------------

  /** Registers sends in flight for a question; settle() waits for them before editing. */
  private track(questionId: number, work: Promise<unknown>): Promise<void> {
    const all = Promise.allSettled([this.sending.get(questionId), work]).then(() => undefined);
    this.sending.set(questionId, all);
    void all.finally(() => {
      if (this.sending.get(questionId) === all) this.sending.delete(questionId);
    });
    return all;
  }

  /** Sends one recipient its copy of the question. Never rejects; a failed send is logged. */
  private async post(question: Question, chatId: number): Promise<void> {
    const layout = layoutQuestion(question, this.originOf(question), this.store.clock.now(), this.timeZone);
    try {
      let messageId = 0;
      for (const [i, part] of layout.parts.entries()) {
        const last = i === layout.parts.length - 1;
        ({ messageId } = await this.transport.sendMessage(
          chatId,
          part,
          last ? { keyboard: layout.keyboard } : {},
        ));
        this.link(chatId, messageId, question.id);
      }
      this.addPost(question.id, { chatId, messageId, base: layout.resolvedBase });
    } catch (error) {
      // Typically a user on the allowlist who never pressed Start: Telegram refuses the first message.
      this.log(`[telegram] could not send question ${question.id} to ${chatId}: ${String(error)}`);
    }
  }

  /** Edits every copy of the question to show the outcome without buttons. Returns the posts edited. */
  private async settle(event: QuestionResolvedEvent, line: string): Promise<Post[]> {
    await this.sending.get(event.question.id);
    const posts = this.posts.get(event.question.id) ?? [];
    this.posts.delete(event.question.id);
    await Promise.allSettled(
      posts.map((p) =>
        this.transport
          .editMessage(p.chatId, p.messageId, resolvedText(p.base, line))
          .catch((error: unknown) => this.log(`[telegram] edit in ${p.chatId} failed: ${String(error)}`)),
      ),
    );
    return posts;
  }

  private originOf(question: Question): QuestionOrigin {
    const session = this.store.sessions.get(question.sessionId);
    const project = session && this.store.projects.get(session.projectId);
    const subagent = question.subagentId === null ? undefined : this.store.subagents.get(question.subagentId);
    return {
      ...(project ? { projectName: project.name } : {}),
      ...(session ? { sessionTitle: session.title } : {}),
      ...(subagent ? { subagentTitle: subagent.title } : {}),
    };
  }

  private addPost(questionId: number, post: Post): void {
    const posts = this.posts.get(questionId) ?? [];
    if (!posts.some((p) => p.chatId === post.chatId && p.messageId === post.messageId)) posts.push(post);
    this.posts.set(questionId, posts);
  }

  private link(chatId: number, messageId: number, questionId: number): void {
    if (this.links.size >= MAX_LINKS) {
      const oldest = this.links.keys().next().value;
      if (oldest !== undefined) this.links.delete(oldest);
    }
    this.links.set(`${chatId}:${messageId}`, questionId);
  }

  // --- Updates ---------------------------------------------------------------------------------

  private async onCallback(query: CallbackQuery): Promise<void> {
    const message = query.message;
    // No message (inline mode, or too old for Telegram to include): the chat is unknown, so refuse.
    if (!this.access.isAllowed(query.from.id) || message?.chat.type !== 'private') {
      this.access.ignored(query.from.id, 'button tap');
      return;
    }
    const parsed = parseCallbackData(query.data);
    const question = parsed && this.store.questions.get(parsed.questionId);
    const option = parsed && question?.options[parsed.optionIndex];
    if (!question || option == null) {
      await this.transport.answerCallback(query.id, 'This button is no longer valid.');
      return;
    }
    // A message from before a restart is not tracked; adopt it so the outcome edit reaches it.
    const tapped: Post | null =
      message && 'text' in message && message.text !== undefined
        ? { chatId: message.chat.id, messageId: message.message_id, base: stripFooter(message.text) }
        : null;

    if (question.status !== 'pending') {
      await this.transport.answerCallback(query.id, alreadySettledText(question));
      // Buttons still showing on a settled question (e.g. sent before a restart): clear them.
      if (tapped && message?.reply_markup?.inline_keyboard.length) {
        const line = resolutionLine(settledEvent(question));
        await this.transport.editMessage(tapped.chatId, tapped.messageId, resolvedText(tapped.base, line));
      }
      return;
    }
    if (tapped) this.addPost(question.id, tapped);
    this.answeredBy.set(question.id, displayName(query.from));
    const result = this.questions.answer(question.id, option, 'telegram');
    if (!result.accepted) this.answeredBy.delete(question.id);
    await this.transport.answerCallback(
      query.id,
      result.accepted
        ? truncate(`answered: ${option}`, TELEGRAM_LIMITS.callbackAnswer)
        : alreadySettledText(result.question),
    );
  }

  private async onMessage(message: Message): Promise<void> {
    const from = message.from;
    if (!from || !this.access.isAllowed(from.id) || message.chat.type !== 'private') {
      this.access.ignored(from?.id, 'message');
      return;
    }
    const chatId = message.chat.id;
    const reply = (text: string) =>
      this.transport.sendMessage(chatId, truncate(text, TELEGRAM_LIMITS.text), {
        replyTo: message.message_id,
      });
    const text = message.text?.trim();
    if (!text) {
      await reply('I only read text messages.');
      return;
    }
    const questionId = this.repliedQuestion(message);
    // A reply to a question is an answer even when it starts with "/" (e.g. "/tmp is fine"),
    // unless it is one of the bot's commands.
    if (text.startsWith('/') && (questionId === null || isCommand(text))) {
      await reply(this.command(text, chatId));
      return;
    }
    if (questionId !== null) {
      await reply(this.answerWithText(questionId, text, message, from));
      return;
    }
    const option = this.soleOptionMatch(text);
    if (option) {
      await reply(this.answerWithText(option.questionId, option.option, message, from));
      return;
    }
    const request = this.requests.create({ text, source: 'telegram' });
    await reply(
      `Saved as request #${request.id}. It will be routed to a project and session.
` + 'To answer a question instead, reply to the question message.',
    );
  }

  /**
   * A plain message that is exactly one option (ignoring case and surrounding space) of the only
   * pending question answers it, e.g. "postgres" while #12 offers SQLite / Postgres. With more than
   * one question pending it is ambiguous, so it stays a new task.
   */
  private soleOptionMatch(text: string): { questionId: number; option: string } | null {
    const pending = this.store.questions.listPending();
    if (pending.length !== 1) return null;
    const question = pending[0]!;
    const wanted = text.trim().toLowerCase();
    const option = question.options.find((o) => o.trim().toLowerCase() === wanted);
    return option === undefined ? null : { questionId: question.id, option };
  }

  /** The question a message replies to: a tracked message, or a bot message headed "Question #id". */
  private repliedQuestion(message: Message): number | null {
    const original = message.reply_to_message;
    if (!original) return null;
    const linked = this.links.get(`${message.chat.id}:${original.message_id}`);
    if (linked !== undefined) return linked;
    return original.from?.is_bot ? questionIdFromText(original.text) : null;
  }

  private answerWithText(questionId: number, text: string, message: Message, from: User): string {
    const question = this.store.questions.get(questionId);
    if (!question) return `Question #${questionId} no longer exists.`;
    if (question.status !== 'pending') return alreadySettledText(question);
    const original = message.reply_to_message;
    if (original?.text?.includes(`\n\n${FOOTER_MARK}`)) {
      this.addPost(questionId, {
        chatId: message.chat.id,
        messageId: original.message_id,
        base: stripFooter(original.text),
      });
    }
    this.answeredBy.set(questionId, displayName(from));
    try {
      const result = this.questions.answer(questionId, text, 'telegram');
      if (result.accepted) return `answered #${questionId}: ${truncate(text, 200)}`;
      this.answeredBy.delete(questionId);
      return alreadySettledText(result.question);
    } catch (error) {
      this.answeredBy.delete(questionId);
      if (error instanceof ValidationError) return `Not accepted: ${error.message}.`;
      throw error;
    }
  }

  private command(text: string, chatId: number): string {
    const [word = '', arg] = text.split(/\s+/);
    const name = (word.split('@')[0] ?? '').toLowerCase();
    const id = /^\/q(\d+)$/.exec(name)?.[1] ?? (name === '/q' ? (arg ?? '') : undefined);
    if (id !== undefined)
      return /^\d{1,15}$/.test(id) ? this.reshow(Number(id), chatId) : 'Usage: /q<id>, e.g. /q12';
    switch (name) {
      case '/start':
      case '/help':
        return HELP;
      case '/status':
        return this.status();
      default:
        return `Unknown command ${truncate(word, 40)}.\n\n${HELP}`;
    }
  }

  private reshow(questionId: number, chatId: number): string {
    const question = this.store.questions.get(questionId);
    if (!question) return `Question #${questionId} does not exist.`;
    if (question.status !== 'pending') return alreadySettledText(question);
    void this.track(questionId, this.post(question, chatId));
    return `Showing question #${questionId} again.`;
  }

  private status(): string {
    const now = this.store.clock.now().getTime();
    const pending = this.store.questions.listPending();
    const sessions = this.store.sessions.list({ status: ['active', 'paused'] });
    const unrouted = this.store.requests.list({ projectId: null }).length;
    const lines: string[] = [`Pending questions: ${pending.length}`];
    for (const q of pending.slice(0, 10)) {
      const minutes = Math.max(0, Math.round((Date.parse(q.deadline) - now) / 60_000));
      lines.push(`#${q.id} ${truncate(q.text.replace(/\s+/g, ' '), 80)} (${minutes} min left) /q${q.id}`);
    }
    if (pending.length > 10) lines.push(`…and ${pending.length - 10} more`);
    lines.push('', `Active sessions: ${sessions.length}`);
    const projects = new Map(this.store.projects.list().map((p) => [p.id, p.name]));
    for (const s of sessions.slice(0, 10)) {
      const state = s.status === 'paused' ? `paused (${s.pauseReason ?? 'manual'})` : 'running';
      const where = `${projects.get(s.projectId) ?? `project ${s.projectId}`} / ${truncate(s.title, 60)}`;
      lines.push(`#${s.id} ${where}: ${state}, ${s.provider} ${s.model}`);
    }
    if (sessions.length > 10) lines.push(`…and ${sessions.length - 10} more`);
    if (unrouted > 0) lines.push('', `Requests waiting for routing: ${unrouted}`);
    return lines.join('\n');
  }
}

const COMMANDS = new Set(['/start', '/help', '/status', '/q']);

/** Whether text starts with one of the bot's commands (including /q<id>). */
function isCommand(text: string): boolean {
  const name = (text.split(/\s+/)[0]?.split('@')[0] ?? '').toLowerCase();
  return COMMANDS.has(name) || /^\/q\d+$/.test(name);
}

/** A resolved event rebuilt from a settled question, for editing a message after the fact. */
function settledEvent(question: Question): QuestionResolvedEvent {
  return {
    type: 'question.resolved',
    question,
    answer: question.answer ?? question.recommendedOption,
    answeredVia: question.answeredVia ?? 'timeout',
    defaulted: question.status === 'defaulted',
  };
}

function displayName(user: User): string {
  return truncate(
    user.username ? `@${user.username}` : [user.first_name, user.last_name].filter(Boolean).join(' '),
    60,
  );
}
