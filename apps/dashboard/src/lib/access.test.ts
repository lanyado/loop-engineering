import { describe, expect, it, vi } from 'vitest';
import { accessConfig, checkLocalRequest, type LocalRequest } from './access';
import { refuseUnsafeStart } from './server/startup';

const PASSWORD = { DASHBOARD_PASSWORD: 'p'.repeat(12), DASHBOARD_SESSION_SECRET: 's'.repeat(32) };

describe('accessConfig', () => {
  it('defaults to none on loopback, whichever loopback name is used', () => {
    for (const host of [undefined, '', '127.0.0.1', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
      expect(accessConfig({ DASHBOARD_HOST: host })).toEqual({ mode: 'none', problem: null });
    }
  });

  it('keeps password mode available on loopback, with or without its variables', () => {
    expect(accessConfig({ DASHBOARD_AUTH: 'password', ...PASSWORD })).toEqual({
      mode: 'password',
      problem: null,
    });
    // As before: a missing password is reported on the login page, not at start.
    expect(accessConfig({ DASHBOARD_AUTH: 'password' })).toEqual({ mode: 'password', problem: null });
  });

  it('refuses a non-loopback host without password auth', () => {
    for (const host of ['0.0.0.0', '192.168.1.20', '127.0.0.2', 'example.com', '::']) {
      for (const auth of [undefined, 'none']) {
        const config = accessConfig({ DASHBOARD_HOST: host, DASHBOARD_AUTH: auth, ...PASSWORD });
        expect(config.mode).toBeNull();
        expect(config.problem).toContain('DASHBOARD_AUTH=password');
      }
    }
  });

  it('on a non-loopback host, password mode needs the password and a real session secret', () => {
    const host = { DASHBOARD_HOST: '0.0.0.0', DASHBOARD_AUTH: 'password' };
    expect(accessConfig({ ...host, ...PASSWORD })).toEqual({ mode: 'password', problem: null });
    expect(accessConfig(host).problem).toMatch(/DASHBOARD_PASSWORD is not set/);
    expect(accessConfig({ ...host, DASHBOARD_PASSWORD: 'p'.repeat(12) }).problem).toMatch(
      /DASHBOARD_SESSION_SECRET/,
    );
  });

  it('treats Vercel as non-loopback', () => {
    expect(accessConfig({ VERCEL: '1' }).problem).toMatch(/On Vercel/);
    expect(accessConfig({ VERCEL: '1', DASHBOARD_AUTH: 'password', ...PASSWORD }).mode).toBe('password');
  });

  it('rejects an unknown mode', () => {
    expect(accessConfig({ DASHBOARD_AUTH: 'off' }).problem).toMatch(/"none" or "password"/);
  });
});

describe('startup bind check', () => {
  const run = (env: Record<string, string | undefined>, argv: string[], addresses: string[] = []) => {
    const exit = vi.fn<(code: number) => never>();
    const log = vi.fn();
    const copy = { ...env };
    refuseUnsafeStart(copy, { argv: ['node', 'next', ...argv], addresses }, exit, log);
    return {
      refused: exit.mock.calls.length > 0,
      line: log.mock.calls[0]?.[0] as string | undefined,
      env: copy,
    };
  };

  it('refuses a no-login dashboard bound beyond loopback, however that was asked for', () => {
    for (const [argv, env] of <[string[], Record<string, string>][]>[
      [['start', '-H', '0.0.0.0'], {}],
      [['start', '--hostname', '0.0.0.0'], {}],
      [['start', '--hostname=0.0.0.0'], {}],
      [['start', '-H', '192.168.1.20'], {}],
      [['start'], {}], // bare: Next binds every interface
      [['start'], { HOSTNAME: '0.0.0.0' }], // standalone server.js
      [['start', '-H', '127.0.0.1', '-H', '0.0.0.0'], {}], // the last flag wins
      [['start', '-H', '0.0.0.0'], { DASHBOARD_HOST: '127.0.0.1' }], // DASHBOARD_HOST cannot vouch
      [['start', '-H', 'my-laptop.local'], {}],
    ]) {
      const result = run(env, argv);
      expect(result.refused, JSON.stringify([argv, env])).toBe(true);
      expect(result.line).toMatch(/^\[dashboard\] refusing to start: .*DASHBOARD_AUTH=password/);
      expect(result.line).not.toContain('\n');
    }
  });

  it('judges the socket actually bound over any flag', () => {
    expect(run({}, ['start', '-H', '127.0.0.1'], ['::']).refused).toBe(true);
    expect(run({}, ['start', '-H', '127.0.0.1'], ['0.0.0.0']).refused).toBe(true);
    expect(run({}, ['start'], ['127.0.0.1']).refused).toBe(false); // e.g. the forked dev worker
  });

  it('starts on loopback with no auth variables', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(run({}, ['start', '-H', host]).refused, host).toBe(false);
      expect(run({}, ['start', `--hostname=${host}`]).refused, host).toBe(false);
    }
    expect(run({}, ['start'], ['::1']).refused).toBe(false);
  });

  it('password mode may bind anywhere, with its password and secret', () => {
    const result = run({ DASHBOARD_AUTH: 'password', ...PASSWORD }, ['start', '-H', '0.0.0.0'], ['0.0.0.0']);
    expect(result.refused).toBe(false);
    // The per-request checks then judge the real bind too.
    expect(result.env.DASHBOARD_HOST).toBe('0.0.0.0');
    expect(run({ DASHBOARD_AUTH: 'password' }, ['start', '-H', '0.0.0.0']).refused).toBe(true);
  });
});

describe('checkLocalRequest', () => {
  const PORT = '3737';
  const req = (over: Partial<LocalRequest>): LocalRequest => ({
    method: 'GET',
    host: '127.0.0.1:3737',
    origin: null,
    secFetchSite: null,
    isAction: false,
    ...over,
  });

  it('allows pages and same-origin writes on this machine at this port', () => {
    for (const host of ['127.0.0.1:3737', 'localhost:3737', '[::1]:3737', 'LocalHost:3737']) {
      expect(checkLocalRequest(req({ host }), PORT)).toEqual({ ok: true });
    }
    expect(
      checkLocalRequest(req({ method: 'POST', origin: 'http://localhost:3737', isAction: true }), PORT),
    ).toEqual({ ok: true });
    expect(checkLocalRequest(req({ method: 'POST', secFetchSite: 'same-origin' }), PORT)).toEqual({
      ok: true,
    });
  });

  it('refuses a foreign Host, including look-alikes and other ports (DNS rebinding)', () => {
    for (const host of [
      'evil.com',
      'evil.com:3737',
      '127.0.0.1.evil.com:3737',
      '127.0.0.1:3738',
      '127.0.0.1',
      'localhost',
      '192.168.1.20:3737',
      null,
    ]) {
      expect(checkLocalRequest(req({ host }), PORT).ok, String(host)).toBe(false);
    }
  });

  it('refuses a write from another origin', () => {
    for (const origin of [
      'http://evil.com',
      'https://127.0.0.1:3737',
      'http://127.0.0.1:3738',
      'http://127.0.0.1.evil.com:3737',
      'null',
    ]) {
      expect(checkLocalRequest(req({ method: 'POST', origin }), PORT).ok, origin).toBe(false);
    }
    // A Server Action is a write even if it somehow arrives as GET.
    expect(checkLocalRequest(req({ isAction: true, origin: 'http://evil.com' }), PORT).ok).toBe(false);
  });

  it('refuses a write with no Origin unless the browser marks it same-origin', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(checkLocalRequest(req({ method }), PORT).ok).toBe(false);
      expect(checkLocalRequest(req({ method, secFetchSite: 'cross-site' }), PORT).ok).toBe(false);
      expect(checkLocalRequest(req({ method, secFetchSite: 'same-site' }), PORT).ok).toBe(false);
    }
    expect(checkLocalRequest(req({ isAction: true }), PORT).ok).toBe(false);
  });
});
