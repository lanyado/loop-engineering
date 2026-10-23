import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionToken } from './lib/auth';
import { proxy } from './proxy';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function request(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return new NextRequest(`http://127.0.0.1:3737${path}`, {
    method,
    headers: { host: '127.0.0.1:3737', ...headers },
  });
}

const passes = (res: Response) => res.headers.get('x-middleware-next') === '1';

describe('proxy, DASHBOARD_AUTH=none (the loopback default)', () => {
  const env = () => {
    process.env = { ...saved, PORT: '3737', DASHBOARD_HOST: '127.0.0.1' };
    delete process.env.DASHBOARD_AUTH;
    delete process.env.VERCEL;
  };

  it('lets pages, the SSE relay and same-origin writes through without a cookie', async () => {
    env();
    expect(passes(await proxy(request('/tree')))).toBe(true);
    expect(passes(await proxy(request('/api/events', { host: 'localhost:3737' })))).toBe(true);
    const action = request('/', { origin: 'http://127.0.0.1:3737', 'next-action': 'abc' }, 'POST');
    expect(passes(await proxy(action))).toBe(true);
  });

  it('sends /login to /', async () => {
    env();
    const res = await proxy(request('/login?next=%2Ftree'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/');
  });

  it('answers 403 to a foreign Host on pages, routes and actions', async () => {
    env();
    for (const host of ['evil.com:3737', '127.0.0.1.evil.com:3737', '127.0.0.1:9999']) {
      for (const path of ['/', '/api/events', '/login']) {
        expect((await proxy(request(path, { host }))).status, `${host}${path}`).toBe(403);
      }
    }
  });

  it('answers 403 to a cross-origin or Origin-less write', async () => {
    env();
    const evil = request('/', { origin: 'http://evil.com', 'next-action': 'abc' }, 'POST');
    expect((await proxy(evil)).status).toBe(403);
    expect((await proxy(request('/settings', { 'next-action': 'abc' }, 'POST'))).status).toBe(403);
    expect((await proxy(request('/api/events', {}, 'POST'))).status).toBe(403);
  });

  it('answers 500 when the setup is refused (non-loopback host without password auth)', async () => {
    env();
    process.env.DASHBOARD_HOST = '0.0.0.0';
    expect((await proxy(request('/'))).status).toBe(500);
  });
});

describe('proxy, DASHBOARD_AUTH=password (unchanged)', () => {
  const SECRET = 's'.repeat(32);
  const env = () => {
    process.env = {
      ...saved,
      DASHBOARD_AUTH: 'password',
      DASHBOARD_PASSWORD: 'p'.repeat(12),
      DASHBOARD_SESSION_SECRET: SECRET,
    };
  };

  it('redirects logged-out pages to /login with next, 401s the API, passes a valid cookie', async () => {
    env();
    const page = await proxy(request('/tree'));
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toMatch(/\/login\?next=%2Ftree$/);
    expect((await proxy(request('/api/events'))).status).toBe(401);
    expect(passes(await proxy(request('/login')))).toBe(true);
    const cookie = `loop_session=${await createSessionToken(SECRET, Date.now())}`;
    expect(passes(await proxy(request('/tree', { cookie })))).toBe(true);
  });
});
