import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  authConfig,
  cookieIsSecure,
  createSessionToken,
  passwordMatches,
  safeNextPath,
  SESSION_TTL_MS,
  verifySessionToken,
} from './auth';

const SECRET = 'correct-horse-battery-staple';
const NOW = Date.parse('2026-10-18T09:00:00.000Z');

describe('session tokens', () => {
  it('verifies a token it signed until it expires', async () => {
    const token = await createSessionToken(SECRET, NOW);
    expect(token).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]+$/);
    expect(await verifySessionToken(SECRET, token, NOW)).toBe(true);
    expect(await verifySessionToken(SECRET, token, NOW + SESSION_TTL_MS - 1)).toBe(true);
    expect(await verifySessionToken(SECRET, token, NOW + SESSION_TTL_MS)).toBe(false);
  });

  it('rejects other secrets, tampering and junk', async () => {
    const token = await createSessionToken(SECRET, NOW);
    const [, expires, signature] = token.split('.');
    expect(await verifySessionToken('another-secret-value', token, NOW)).toBe(false);
    // Extending the expiry invalidates the signature.
    expect(await verifySessionToken(SECRET, `v1.${Number(expires) + 1}.${signature}`, NOW)).toBe(false);
    const flipped = signature!.startsWith('A') ? `B${signature!.slice(1)}` : `A${signature!.slice(1)}`;
    expect(await verifySessionToken(SECRET, `v1.${expires}.${flipped}`, NOW)).toBe(false);
    for (const junk of [
      undefined,
      '',
      'v1',
      'v1..',
      `v2.${expires}.${signature}`,
      `${token}.x`,
      'v1.abc.def',
      'x'.repeat(500),
    ]) {
      expect(await verifySessionToken(SECRET, junk, NOW)).toBe(false);
    }
    expect(await verifySessionToken(SECRET, `v1.${expires}.not+base64/`, NOW)).toBe(false);
  });
});

describe('passwordMatches', () => {
  it('compares exactly, through PBKDF2', async () => {
    const fast = 1000; // the real cost (600k) is exercised once below
    expect(await passwordMatches('hunter2-hunter2', 'hunter2-hunter2', fast)).toBe(true);
    expect(await passwordMatches('hunter2-hunter3', 'hunter2-hunter2', fast)).toBe(false);
    expect(await passwordMatches('', 'hunter2-hunter2', fast)).toBe(false);
    expect(await passwordMatches('hunter2-hunter2 ', 'hunter2-hunter2', fast)).toBe(false);
    expect(await passwordMatches('hunter2-hunter2', 'hunter2-hunter2')).toBe(true);
  });
});

const SECRET_32 = 'a'.repeat(32);

describe('authConfig', () => {
  it('needs a long enough password', () => {
    expect(authConfig({}).password).toBeNull();
    expect(authConfig({ DASHBOARD_PASSWORD: 'short' }).problem).toMatch(/at least 12/);
  });

  it('signs cookies with DASHBOARD_SESSION_SECRET, never the password', () => {
    expect(
      authConfig({ DASHBOARD_PASSWORD: 'long-enough-pass', DASHBOARD_SESSION_SECRET: SECRET_32 }),
    ).toEqual({
      password: 'long-enough-pass',
      secret: SECRET_32,
      problem: null,
    });
  });

  it('fails closed in production (or on Vercel) without a strong secret', () => {
    for (const env of [
      { NODE_ENV: 'production' },
      { VERCEL: '1' },
      { DASHBOARD_SESSION_SECRET: 'too-short' },
    ]) {
      const config = authConfig({ DASHBOARD_PASSWORD: 'long-enough-pass', ...env });
      expect(config).toMatchObject({ password: null, secret: null });
      expect(config.problem).toMatch(/DASHBOARD_SESSION_SECRET/);
    }
  });

  it('lets local `next dev` run without a secret', () => {
    const config = authConfig({ DASHBOARD_PASSWORD: 'long-enough-pass', NODE_ENV: 'development' });
    expect(config.problem).toBeNull();
    expect(config.secret).not.toBe('long-enough-pass');
  });
});

describe('safeNextPath', () => {
  it('only allows same-origin paths', () => {
    expect(safeNextPath('/prs?x=1')).toBe('/prs?x=1');
    expect(safeNextPath('/tree#shop')).toBe('/tree#shop');
    expect(safeNextPath('/a/../prs')).toBe('/prs');
    for (const bad of [
      undefined,
      null,
      '',
      42,
      'prs',
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      '/%0a/x\u0000',
      '/x\u007f',
    ]) {
      expect(safeNextPath(bad), JSON.stringify(bad)).toBe('/');
    }
    expect(safeNextPath('/login?next=/x')).toBe('/');
  });
});

describe('cookieIsSecure', () => {
  const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;

  it('is off over plain http, including localhost, even in production', () => {
    expect(cookieIsSecure(headers({ origin: 'http://localhost:3737' }), 'production')).toBe(false);
    expect(cookieIsSecure(headers({ origin: 'http://127.0.0.1:3737' }), 'production')).toBe(false);
    expect(cookieIsSecure(headers({ 'x-forwarded-proto': 'http' }), 'production')).toBe(false);
  });

  it('is on over https, direct or behind a proxy', () => {
    expect(cookieIsSecure(headers({ origin: 'https://dash.example.com' }), 'development')).toBe(true);
    expect(cookieIsSecure(headers({ 'x-forwarded-proto': 'https, http' }), 'development')).toBe(true);
  });

  it('falls back to NODE_ENV without a hint', () => {
    expect(cookieIsSecure(headers({}), 'production')).toBe(true);
    expect(cookieIsSecure(headers({}), 'development')).toBe(false);
  });
});

describe('dashboard scripts', () => {
  it('start through scripts/serve.mjs, which binds DASHBOARD_HOST (default loopback) after checking it', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const name of ['dev', 'start']) {
      expect(pkg.scripts[name]).toBe(`node scripts/serve.mjs ${name}`);
    }
  });
});
