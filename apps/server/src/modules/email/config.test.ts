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
          EMAIL_PROJECT: 'shop',
        }),
      ),
    ).toEqual({
      enabled: true,
      config: {
        address: 'loop.bot@gmail.com',
        password: 'abcdefghijklmnop',
        allowlist: ['dana@acme.com', '@team.example'],
        pollMs: 60_000,
        project: 'shop',
      },
    });
  });

  it('reads what the project is, when it is set', () => {
    const result = loadEmailConfig(
      env({
        EMAIL_ADDRESS: 'loop@team.example',
        EMAIL_APP_PASSWORD: 'abcd',
        EMAIL_ALLOWLIST: 'dana@acme.com',
        EMAIL_PROJECT: 'shop',
        EMAIL_PROJECT_ABOUT: ' A shop for hats. ',
      }),
    );
    expect(result.enabled && result.config.about).toBe('A shop for hats.');
  });

  it('reads who gets alerts, and refuses an address that is not one', () => {
    const base = {
      EMAIL_ADDRESS: 'loop@team.example',
      EMAIL_APP_PASSWORD: 'abcd',
      EMAIL_ALLOWLIST: 'dana@acme.com',
      EMAIL_PROJECT: 'shop',
    };
    const result = loadEmailConfig(env({ ...base, EMAIL_OWNER: ' Dana@Acme.com ' }));
    expect(result.enabled && result.config.owner).toBe('dana@acme.com');
    expect(() => loadEmailConfig(env({ ...base, EMAIL_OWNER: 'dana' }))).toThrow(/EMAIL_OWNER/);
    expect(() => loadEmailConfig(env({ ...base, EMAIL_OWNER: 'sam@acme.com' }))).toThrow(
      /must be on EMAIL_ALLOWLIST/,
    );
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
    for (const domain of [
      '@fastmail.com',
      '@pm.me',
      '@proton.me',
      '@mail.ru',
      '@qq.com',
      '@163.com',
      '@gmx.de',
      '@yandex.ru',
      '@zoho.com',
      '@aol.com',
      '@icloud.com',
      '@me.com',
      '@mac.com',
      '@hey.com',
      '@tutanota.com',
      '@tuta.io',
      '@googlegroups.com',
    ])
      expect(
        () =>
          loadEmailConfig(env({ EMAIL_ADDRESS: 'a@b.co', EMAIL_APP_PASSWORD: 'x', EMAIL_ALLOWLIST: domain })),
        domain,
      ).toThrow(/anyone can have an address there/);
    expect(
      loadEmailConfig(
        env({
          EMAIL_ADDRESS: 'a@b.co',
          EMAIL_APP_PASSWORD: 'x',
          EMAIL_ALLOWLIST: '@mail.acme.com, @gmailer.com',
          EMAIL_PROJECT: 'shop',
        }),
      ).enabled,
    ).toBe(true);
    expect(() => loadEmailConfig(env({ EMAIL_ADDRESS: 'a@b.co', EMAIL_APP_PASSWORD: 'x' }))).toThrow(
      /EMAIL_ALLOWLIST is empty/,
    );
  });
});
