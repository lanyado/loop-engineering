import { describe, expect, it } from 'vitest';
import { loadEmailConfig } from './config.js';

const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

describe('loadEmailConfig', () => {
  it('is off without an address, and reads a full setup', () => {
    expect(loadEmailConfig(env({}))).toEqual({ enabled: false, reason: 'EMAIL_ADDRESS is not set' });
    expect(
      loadEmailConfig(
        env({
          EMAIL_ADDRESS: 'Loop.Bot@gmail.com',
          EMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop',
          EMAIL_ALLOWLIST: 'Dana@acme.com, @team.example',
        }),
      ),
    ).toEqual({
      enabled: true,
      config: {
        address: 'loop.bot@gmail.com',
        password: 'abcdefghijklmnop',
        allowlist: ['dana@acme.com', '@team.example'],
        pollMs: 60_000,
      },
    });
  });

  it('lists every problem of a half setup', () => {
    expect(() =>
      loadEmailConfig(env({ EMAIL_ADDRESS: 'loop', EMAIL_ALLOWLIST: 'nobody, @', EMAIL_POLL_SECONDS: '5' })),
    ).toThrow(
      /EMAIL_ADDRESS is not an email address.*EMAIL_APP_PASSWORD is not set.*"nobody".*"@".*EMAIL_POLL_SECONDS/,
    );
    expect(() =>
      loadEmailConfig(
        env({
          EMAIL_ADDRESS: 'a@b.co',
          EMAIL_APP_PASSWORD: 'x',
          EMAIL_ALLOWLIST: '@gmail.com, @yahoo.co.uk',
        }),
      ),
    ).toThrow(/"@gmail.com".*"@yahoo.co.uk"/);
    expect(
      loadEmailConfig(
        env({
          EMAIL_ADDRESS: 'a@b.co',
          EMAIL_APP_PASSWORD: 'x',
          EMAIL_ALLOWLIST: '@mail.acme.com, @gmailer.com',
        }),
      ).enabled,
    ).toBe(true);
    expect(() => loadEmailConfig(env({ EMAIL_ADDRESS: 'a@b.co', EMAIL_APP_PASSWORD: 'x' }))).toThrow(
      /EMAIL_ALLOWLIST is empty/,
    );
  });
});
