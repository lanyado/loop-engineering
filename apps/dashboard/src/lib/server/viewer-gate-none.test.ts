import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoBackend } from '../demo-backend';

// DASHBOARD_AUTH=none (the loopback default): no login, but every page and Server Action still
// checks the request's Host (and an action's Origin) itself before any data is fetched, so a
// rebound hostname or a cross-site form gets nothing even if it got past the proxy.

const m = vi.hoisted(() => {
  class Redirect extends Error {
    constructor(readonly url: string) {
      super(`NEXT_REDIRECT ${url}`);
    }
  }
  return { Redirect, headers: new Headers(), backendCalls: 0, cookiesSet: [] as string[] };
});

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: () => undefined,
      set: (name: string, value: string) => m.cookiesSet.push(`${name}=${value}`),
      delete: () => {},
    }),
  headers: () => Promise.resolve(m.headers),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new m.Redirect(url);
  },
}));
vi.mock('next/cache', () => ({ refresh: () => {} }));
vi.mock('./env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env')>()),
  backendWithoutLoginCheck: () => {
    m.backendCalls++;
    return new DemoBackend();
  },
}));

const saved = { ...process.env };
for (const name of ['DASHBOARD_AUTH', 'DASHBOARD_PASSWORD', 'DASHBOARD_SESSION_SECRET', 'VERCEL']) {
  delete process.env[name];
}
process.env.DASHBOARD_HOST = '127.0.0.1';
process.env.PORT = '3737';
afterAll(() => {
  process.env = saved;
});

const pages = {
  'layout.tsx': () => import('../../app/(app)/layout'),
  'page.tsx (board)': () => import('../../app/(app)/page'),
} as Record<string, () => Promise<{ default: (props: { children: null }) => unknown }>>;

const setHeaders = (entries: Record<string, string>) => {
  m.headers = new Headers(entries);
};

beforeEach(() => {
  m.backendCalls = 0;
  m.cookiesSet = [];
  setHeaders({ host: '127.0.0.1:3737' });
});

describe('pages', () => {
  it('render without a cookie for this machine', async () => {
    for (const load of Object.values(pages)) await (await load()).default({ children: null });
    expect(m.backendCalls).toBe(Object.keys(pages).length);
  });

  it('refuse a foreign Host before fetching anything', async () => {
    for (const host of ['evil.com:3737', '127.0.0.1.evil.com:3737', '127.0.0.1:1234']) {
      setHeaders({ host });
      for (const [name, load] of Object.entries(pages)) {
        const { default: Page } = await load();
        await expect(
          Promise.resolve().then(() => Page({ children: null })),
          `${name} ${host}`,
        ).rejects.toThrow('Forbidden');
      }
    }
    expect(m.backendCalls).toBe(0);
  });
});

describe('Server Actions', () => {
  const answer = async () => (await import('../../app/actions')).answerQuestion(1, 'Postgres');
  const theme = async () => (await import('../../app/actions')).setTheme('dark');

  it('run for a same-origin call', async () => {
    setHeaders({ host: '127.0.0.1:3737', origin: 'http://127.0.0.1:3737', 'next-action': 'x' });
    // Demo backend: refused as read-only, after the access check passed.
    expect(await answer()).toMatchObject({ ok: false, error: /read-only/ });
    expect(m.backendCalls).toBe(1);
    await theme();
    expect(m.cookiesSet).toEqual(['loop-theme=dark']);
  });

  it('refuse a cross-origin, Origin-less or foreign-Host call', async () => {
    for (const headers of <Record<string, string>[]>[
      { host: '127.0.0.1:3737', origin: 'http://evil.com', 'next-action': 'x' },
      { host: '127.0.0.1:3737', 'next-action': 'x' },
      { host: 'evil.com:3737', origin: 'http://evil.com:3737', 'next-action': 'x' },
    ]) {
      setHeaders(headers);
      await expect(answer(), JSON.stringify(headers)).rejects.toThrow('Forbidden');
      await expect(theme(), JSON.stringify(headers)).rejects.toThrow('Forbidden');
    }
    expect(m.backendCalls).toBe(0);
    expect(m.cookiesSet).toEqual([]);
  });
});

describe('login', () => {
  it('the login page and the login/logout actions go to /', async () => {
    const { default: LoginPage } = await import('../../app/login/page');
    await expect(LoginPage({ searchParams: Promise.resolve({ next: '/tree' }) })).rejects.toMatchObject({
      url: '/',
    });
    const actions = await import('../../app/actions');
    await expect(actions.login({ error: null }, new FormData())).rejects.toMatchObject({ url: '/' });
    await expect(actions.logout()).rejects.toMatchObject({ url: '/' });
  });
});
