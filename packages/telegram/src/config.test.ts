import { describe, expect, it } from 'vitest';
import { loadTelegramConfig, TelegramConfigError } from './config.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

describe('loadTelegramConfig', () => {
  it('is disabled without a token', () => {
    expect(loadTelegramConfig({})).toEqual({ enabled: false, reason: 'TELEGRAM_BOT_TOKEN is not set' });
    expect(loadTelegramConfig({ TELEGRAM_BOT_TOKEN: '  ' }).enabled).toBe(false);
  });

  it('defaults to long polling', () => {
    expect(loadTelegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_OWNER_ID: '42' })).toEqual({
      enabled: true,
      config: {
        token: TOKEN,
        ownerId: 42,
        timeZone: null,
      },
    });
  });

  it('reads the time zone', () => {
    expect(
      loadTelegramConfig({
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_OWNER_ID: '42',
        TELEGRAM_TIME_ZONE: 'Asia/Jerusalem',
      }),
    ).toMatchObject({ enabled: true, config: { timeZone: 'Asia/Jerusalem' } });
  });

  it('fails loudly when the removed webhook mode is still configured', () => {
    expect(() =>
      loadTelegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_OWNER_ID: '42', TELEGRAM_MODE: 'webhook' }),
    ).toThrow(/webhook mode was removed; unset TELEGRAM_MODE/);
  });

  it('lists every problem of a half-configured bot', () => {
    let error: unknown;
    try {
      loadTelegramConfig({
        TELEGRAM_BOT_TOKEN: 'nope',
        TELEGRAM_OWNER_ID: '@rotem',
        TELEGRAM_TIME_ZONE: 'Mars/Base',
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TelegramConfigError);
    const message = (error as Error).message;
    for (const name of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_ID', 'TELEGRAM_TIME_ZONE']) {
      expect(message).toContain(name);
    }
  });
});
