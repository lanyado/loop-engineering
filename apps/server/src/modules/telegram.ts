import {
  GrammyTransport,
  TelegramBot,
  type TelegramConfigResult,
  type TelegramTransport,
} from '@loop-engineering/telegram';
import type { ServerContext, ServerModule } from '../context.js';

export interface TelegramModuleOptions {
  /** From loadTelegramConfig(). Disabled: the module only logs why and does nothing else. */
  telegram: TelegramConfigResult;
  /** Replaces the grammY transport (MockTelegram in tests). */
  transport?: TelegramTransport;
  log?: (message: string) => void;
}

/** The Telegram bot as a server module. It long-polls from start(), so it needs no inbound route. */
export function telegramModule(options: TelegramModuleOptions): ServerModule & { bot(): TelegramBot | null } {
  const log = options.log ?? console.log;
  let bot: TelegramBot | null = null;
  let transport: TelegramTransport | null = null;
  const settings = options.telegram;

  return {
    name: 'telegram',
    bot: () => bot,

    // Never waits on the network: attaching the bot is synchronous, and polling
    // continues in the background (grammY retries an unreachable API indefinitely).
    start(ctx: ServerContext) {
      if (!settings.enabled) {
        log(`[telegram] bot disabled: ${settings.reason}`);
        return;
      }
      const { config } = settings;
      transport = options.transport ?? new GrammyTransport(config.token, log);
      bot = new TelegramBot({
        transport,
        store: ctx.store,
        questions: ctx.questions,
        requests: ctx.requests,
        bus: ctx.bus,
        ownerId: config.ownerId,
        ...(config.timeZone ? { timeZone: config.timeZone } : {}),
        log,
      });
      bot.attach();
      const current = bot;
      transport.startPolling(
        (update) => current.handleUpdate(update),
        () => log('[telegram] bot started (long polling)'),
      );
    },

    async stop() {
      await transport?.stop();
      await bot?.close();
      bot = null;
      transport = null;
    },
  };
}
