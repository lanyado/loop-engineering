import { Bot, GrammyError } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import {
  ALLOWED_UPDATES,
  type Keyboard,
  type SendOptions,
  type TelegramTransport,
  type UpdateHandler,
} from './transport.js';
import { runWithRestarts } from './restart.js';

const markup = (keyboard: Keyboard | undefined): InlineKeyboardMarkup => ({
  inline_keyboard: (keyboard ?? []).map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
});

/**
 * The real Bot API, through grammY. Only constructed when TELEGRAM_BOT_TOKEN is set; tests use
 * MockTelegram instead, and the one test of this class points it at a closed localhost port.
 */
export class GrammyTransport implements TelegramTransport {
  private readonly bot: Bot;
  private polling: Promise<void> | null = null;
  private readonly stopping = new AbortController();

  constructor(
    token: string,
    private readonly log: (message: string) => void = console.log,
    /** Bot API base URL; tests point it at a closed local port to act out "Telegram unreachable". */
    apiRoot?: string,
  ) {
    this.bot = new Bot(token, apiRoot ? { client: { apiRoot } } : {});
  }

  async sendMessage(chatId: number, text: string, options: SendOptions = {}): Promise<{ messageId: number }> {
    const message = await this.bot.api.sendMessage(chatId, text, {
      ...(options.keyboard ? { reply_markup: markup(options.keyboard) } : {}),
      ...(options.replyTo
        ? { reply_parameters: { message_id: options.replyTo, allow_sending_without_reply: true } }
        : {}),
      ...(options.silent ? { disable_notification: true } : {}),
      link_preview_options: { is_disabled: true },
    });
    return { messageId: message.message_id };
  }

  async editMessage(chatId: number, messageId: number, text: string, keyboard?: Keyboard): Promise<void> {
    try {
      await this.bot.api.editMessageText(chatId, messageId, text, {
        reply_markup: markup(keyboard),
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      // Editing to identical content is an error in the Bot API, but not a failure for us.
      if (String(error).includes('message is not modified')) return;
      throw error;
    }
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await this.bot.api.answerCallbackQuery(callbackQueryId, text ? { text } : {});
  }

  startPolling(onUpdate: UpdateHandler, onStarted?: () => void): void {
    this.bot.on(['message', 'callback_query'], (ctx) => onUpdate(ctx.update));
    this.bot.catch((error) => this.log(`[telegram] update failed: ${String(error.error)}`));
    // grammY already retries network errors and 5xx inside start(); it rejects on 401 (bad token),
    // 409 (another poller or a webhook) and other 4xx. Restart on those, except 401, with backoff,
    // so a laptop that boots offline or a brief conflict does not leave the bot silently dead.
    // Runs in the background: while the API is unreachable, start() neither starts nor rejects.
    this.polling = runWithRestarts(
      (started) =>
        this.bot.start({
          allowed_updates: ALLOWED_UPDATES,
          onStart: () => {
            started();
            onStarted?.();
          },
        }),
      {
        signal: this.stopping.signal,
        isFatal: (error) => error instanceof GrammyError && error.error_code === 401,
        log: this.log,
      },
    );
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    try {
      // Rejects when polling is still stuck in setup (e.g. offline since boot); shutdown goes on.
      if (this.bot.isRunning()) await this.bot.stop();
    } catch (error) {
      this.log(`[telegram] stopping polling failed: ${String(error)}`);
    }
    await this.polling;
  }
}
