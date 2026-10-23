export interface TelegramConfig {
  token: string;
  ownerId: number;
  /** IANA zone deadlines are shown in; null: the server's zone. */
  timeZone: string | null;
}

export type TelegramConfigResult =
  { enabled: true; config: TelegramConfig } | { enabled: false; reason: string };

export class TelegramConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramConfigError';
  }
}

/**
 * Reads the bot's settings from the environment. With no TELEGRAM_BOT_TOKEN the bot is disabled
 * (the server runs without it). A token with invalid companions throws, listing every problem,
 * so a half-configured bot fails at start instead of silently never answering.
 */
export function loadTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfigResult {
  const read = (name: string) => env[name]?.trim() ?? '';
  const token = read('TELEGRAM_BOT_TOKEN');
  if (!token) return { enabled: false, reason: 'TELEGRAM_BOT_TOKEN is not set' };

  const problems: string[] = [];
  // BotFather tokens look like "123456789:AAH...": a numeric bot id, a colon, then the secret.
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
    problems.push('TELEGRAM_BOT_TOKEN does not look like a BotFather token ("<digits>:<secret>")');
  }
  const ownerText = read('TELEGRAM_OWNER_ID');
  const ownerId = Number(ownerText);
  if (!/^[1-9]\d*$/.test(ownerText) || !Number.isSafeInteger(ownerId)) {
    problems.push(`TELEGRAM_OWNER_ID must be your numeric Telegram user id, got "${ownerText}"`);
  }
  // Webhook mode is gone; an old .env that still asks for it must not silently fall back to polling.
  if (read('TELEGRAM_MODE') === 'webhook') {
    problems.push('webhook mode was removed; unset TELEGRAM_MODE');
  }

  const timeZone = read('TELEGRAM_TIME_ZONE') || null;
  if (timeZone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone });
    } catch {
      problems.push(`TELEGRAM_TIME_ZONE must be an IANA zone like Asia/Jerusalem, got "${timeZone}"`);
    }
  }

  if (problems.length > 0)
    throw new TelegramConfigError(`Invalid Telegram config:\n- ${problems.join('\n- ')}`);
  return { enabled: true, config: { token, ownerId, timeZone } };
}
