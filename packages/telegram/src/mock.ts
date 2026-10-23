import type { CallbackQuery, Message, Update, User } from 'grammy/types';
import {
  TELEGRAM_LIMITS,
  type Keyboard,
  type SendOptions,
  type TelegramTransport,
  type UpdateHandler,
} from './transport.js';

export interface MockMessage {
  chatId: number;
  messageId: number;
  text: string;
  /** Current buttons; empty once removed by an edit. */
  keyboard: Keyboard;
  replyTo?: number;
  silent: boolean;
  /** Every text this message had, oldest first (the send, then each edit). */
  history: string[];
}

export interface MockCallbackAnswer {
  callbackQueryId: string;
  text?: string;
}

/** A user for injected updates. */
export const mockUser = (id: number, firstName = `user${id}`): User => ({
  id,
  is_bot: false,
  first_name: firstName,
});

const BOT_USER: User = { id: 1, is_bot: true, first_name: 'loop-bot', username: 'loop_bot' };

/**
 * In-memory Telegram for tests: records sent and edited messages and callback answers, enforces
 * Telegram's size limits (so an oversized message fails the test the way the real API would), and
 * injects updates as if Telegram had delivered them. Never touches the network.
 */
export class MockTelegram implements TelegramTransport {
  /** Every message the bot sent, in order, with its current state. */
  readonly messages: MockMessage[] = [];
  readonly callbackAnswers: MockCallbackAnswer[] = [];
  /** Chats whose sends fail, like a user who never pressed Start (403 in the real API). */
  readonly blockedChats = new Set<number>();
  polling = false;
  private handler: UpdateHandler | null = null;
  private nextMessageId = 1000;
  private nextUpdateId = 1;
  private nextCallbackId = 1;

  sendMessage(chatId: number, text: string, options: SendOptions = {}): Promise<{ messageId: number }> {
    return attempt(() => this.send(chatId, text, options));
  }

  private send(chatId: number, text: string, options: SendOptions): { messageId: number } {
    if (this.blockedChats.has(chatId)) throw new Error('Forbidden: bot was blocked by the user');
    checkText(text);
    checkKeyboard(options.keyboard);
    const message: MockMessage = {
      chatId,
      messageId: this.nextMessageId++,
      text,
      keyboard: options.keyboard ?? [],
      ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
      silent: options.silent ?? false,
      history: [text],
    };
    this.messages.push(message);
    return { messageId: message.messageId };
  }

  editMessage(chatId: number, messageId: number, text: string, keyboard?: Keyboard): Promise<void> {
    return attempt(() => {
      checkText(text);
      checkKeyboard(keyboard);
      const message = this.messages.find((m) => m.chatId === chatId && m.messageId === messageId);
      if (!message) throw new Error('Bad Request: message to edit not found');
      message.text = text;
      message.keyboard = keyboard ?? [];
      message.history.push(text);
    });
  }

  answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    return attempt(() => {
      if (text !== undefined && text.length > TELEGRAM_LIMITS.callbackAnswer) {
        throw new Error('callback answer text too long');
      }
      this.callbackAnswers.push({ callbackQueryId, ...(text === undefined ? {} : { text }) });
    });
  }

  startPolling(onUpdate: UpdateHandler, onStarted?: () => void): void {
    this.handler = onUpdate;
    this.polling = true;
    onStarted?.();
  }

  stop(): Promise<void> {
    this.polling = false;
    this.handler = null;
    return Promise.resolve();
  }

  /** Messages sent to one chat, in order. */
  sentTo(chatId: number): MockMessage[] {
    return this.messages.filter((m) => m.chatId === chatId);
  }

  /** The last message sent to a chat. */
  last(chatId: number): MockMessage {
    const message = this.sentTo(chatId).at(-1);
    if (!message) throw new Error(`nothing was sent to chat ${chatId}`);
    return message;
  }

  /** A raw update for a private text message from `from`, optionally replying to one of the bot's messages. */
  messageUpdate(from: User, text: string, replyTo?: MockMessage): Update {
    const message: Message.TextMessage = {
      message_id: this.nextMessageId++,
      date: 0,
      chat: { id: from.id, type: 'private', first_name: from.first_name },
      from,
      text,
      ...(replyTo
        ? { reply_to_message: this.asTelegramMessage(replyTo) as Message.TextMessage['reply_to_message'] }
        : {}),
    };
    return { update_id: this.nextUpdateId++, message: message as Update['message'] };
  }

  /** A raw update for a tap with callback `data` on `message`, by `from`. */
  callbackUpdate(from: User, message: MockMessage, data: string): Update {
    const callback_query: CallbackQuery = {
      id: `cb${this.nextCallbackId++}`,
      from,
      chat_instance: 'ci',
      data,
      message: this.asTelegramMessage(message),
    };
    return { update_id: this.nextUpdateId++, callback_query };
  }

  /** Delivers an update to the polling handler, as Telegram would. */
  async inject(update: Update): Promise<void> {
    if (!this.handler) throw new Error('MockTelegram is not polling; start the bot first');
    await this.handler(update);
  }

  /** Injects a text message. */
  sendText(from: User, text: string, replyTo?: MockMessage): Promise<void> {
    return this.inject(this.messageUpdate(from, text, replyTo));
  }

  /** Injects a tap on the button whose text contains `label`; returns the callback id. */
  async tap(from: User, message: MockMessage, label: string): Promise<string> {
    const button = message.keyboard.flat().find((b) => b.text.includes(label));
    if (!button) throw new Error(`no button "${label}" on message ${message.messageId}`);
    const update = this.callbackUpdate(from, message, button.data);
    await this.inject(update);
    return update.callback_query!.id;
  }

  /** The toast shown for a callback id. */
  answerFor(callbackQueryId: string): string | undefined {
    return this.callbackAnswers.find((a) => a.callbackQueryId === callbackQueryId)?.text;
  }

  private asTelegramMessage(m: MockMessage): Message.TextMessage {
    return {
      message_id: m.messageId,
      date: 0,
      chat: { id: m.chatId, type: 'private', first_name: 'chat' },
      from: BOT_USER,
      text: m.text,
      ...(m.keyboard.length > 0
        ? {
            reply_markup: {
              inline_keyboard: m.keyboard.map((row) =>
                row.map((b) => ({ text: b.text, callback_data: b.data })),
              ),
            },
          }
        : {}),
    };
  }
}

function attempt<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function checkText(text: string): void {
  if (text.length === 0) throw new Error('Bad Request: message text is empty');
  if (text.length > TELEGRAM_LIMITS.text)
    throw new Error(`Bad Request: message is too long (${text.length})`);
}

function checkKeyboard(keyboard: Keyboard | undefined): void {
  for (const button of keyboard?.flat() ?? []) {
    if (Buffer.byteLength(button.data, 'utf8') > TELEGRAM_LIMITS.callbackData) {
      throw new Error(`Bad Request: BUTTON_DATA_INVALID (${button.data})`);
    }
  }
}
