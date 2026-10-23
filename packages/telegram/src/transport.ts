import type { Update } from 'grammy/types';

export type { CallbackQuery, Message, Update, User } from 'grammy/types';

/** One inline button. `data` is the callback_data Telegram sends back on a tap (at most 64 bytes). */
export interface Button {
  text: string;
  data: string;
}

/** Rows of inline buttons. */
export type Keyboard = Button[][];

export interface SendOptions {
  keyboard?: Keyboard;
  /** Message id in the same chat to reply to. */
  replyTo?: number;
  /** Deliver without a sound (Telegram's disable_notification). */
  silent?: boolean;
}

export type UpdateHandler = (update: Update) => Promise<void>;

/**
 * Everything the bot needs from Telegram. GrammyTransport talks to the Bot API; MockTelegram
 * records calls and injects updates in tests. Messages are plain text (no parse_mode), so text
 * from agents never needs escaping and cannot inject markup.
 */
export interface TelegramTransport {
  sendMessage(chatId: number, text: string, options?: SendOptions): Promise<{ messageId: number }>;
  /** Replaces a message's text. Without a keyboard the inline buttons are removed. */
  editMessage(chatId: number, messageId: number, text: string, keyboard?: Keyboard): Promise<void>;
  /** Answers a button tap; `text` shows as a small toast on the user's screen. */
  answerCallback(callbackQueryId: string, text?: string): Promise<void>;
  /**
   * Long polling in the background: fetches updates and hands each to `onUpdate` until stop(),
   * retrying when Telegram is unreachable. Returns at once; `onStarted` runs each time polling
   * (re)starts. Never throws.
   */
  startPolling(onUpdate: UpdateHandler, onStarted?: () => void): void;
  stop(): Promise<void>;
}

/** Telegram's limits (https://core.telegram.org/bots/api). */
export const TELEGRAM_LIMITS = {
  /** Characters in one message's text. */
  text: 4096,
  /** Bytes of callback_data on one button. */
  callbackData: 64,
  /** Characters in a callback answer toast. */
  callbackAnswer: 200,
} as const;

/** The update kinds the bot handles; passed as allowed_updates so Telegram sends nothing else. */
export const ALLOWED_UPDATES = ['message', 'callback_query'] as const;
