import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionToken } from '../auth';
import { DemoBackend } from '../demo-backend';

// Every page and Server Action must check the login itself, before any data is fetched: the
// proxy is one layer, but actions are POST endpoints on every route (including /login, which the
// proxy skips) and layouts don't re-run on client navigation. Next's request APIs are mocked here,
// so pages and actions run as plain functions.

const m = vi.hoisted(() => {
  class Redirect extends Error {
    constructor(readonly url: string) {
      super(`NEXT_REDIRECT ${url}`);
    }
  }
  return {
    Redirect,
    cookie: undefined as string | undefined,
    cookiesSet: [] as string[],
    backendCalls: 0,
  };
});

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: () => (m.cookie === undefined ? undefined : { value: m.cookie }),
      set: (name: string, value: string) => m.cookiesSet.push(`${name}=${value}`),
      delete: () => {},
    }),
  headers: () => Promise.resolve(new Headers()),
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

const SECRET = 's'.repeat(32);
const saved = { ...process.env };
process.env.DASHBOARD_AUTH = 'password'; // the no-login default is covered in viewer-gate-none.test.ts
process.env.DASHBOARD_PASSWORD = 'gate-test-password';
process.env.DASHBOARD_SESSION_SECRET = SECRET;
afterAll(() => {
  process.env = saved;
});

const pages: Record<string, () => Promise<{ default: (props: { children: null }) => unknown }>> = {
  'layout.tsx': () => import('../../app/(app)/layout'),
  'page.tsx (board)': () => import('../../app/(app)/page'),
};

const actions = async () => {
  const a = await import('../../app/actions');
  return {
    answerQuestion: () => a.answerQuestion(1, 'Postgres'),
    setProjectToggle: () => a.setProjectToggle(1, 'autoMerge', true),
    updateSettings: () => a.updateSettings({ sessionModel: 'sonnet' }),
    createRequest: () => a.createRequest('do it', 1),
    messageSession: () => a.messageSession(101, 'also this'),
    endSession: () => a.endSession(101),
    setTheme: () => a.setTheme('dark'),
  };
};

beforeEach(() => {
  m.cookie = undefined;
  m.cookiesSet = [];
  m.backendCalls = 0;
});

describe('without a valid session cookie', () => {
  for (const [name, load] of Object.entries(pages)) {
    it(`${name} redirects to /login before fetching anything`, async () => {
      const { default: Page } = await load();
      for (const cookie of [undefined, 'v1.9999999999999.forged']) {
        m.cookie = cookie;
        await expect(Promise.resolve().then(() => Page({ children: null }))).rejects.toMatchObject({
          url: '/login',
        });
      }
      expect(m.backendCalls).toBe(0);
    });
  }

  it('every data action redirects to /login and never reaches the backend', async () => {
    for (const [name, call] of Object.entries(await actions())) {
      await expect(call(), name).rejects.toMatchObject({ url: '/login' });
    }
    expect(m.backendCalls).toBe(0);
    expect(m.cookiesSet).toEqual([]);
  });
});

describe('with a valid session cookie', () => {
  it('pages and actions reach the backend (so the checks above are not vacuous)', async () => {
    m.cookie = await createSessionToken(SECRET, Date.now());
    for (const load of Object.values(pages)) await (await load()).default({ children: null });
    expect(m.backendCalls).toBe(Object.keys(pages).length);
    // Demo backend: the write is refused as read-only, after the login check passed.
    expect(await (await actions()).answerQuestion()).toMatchObject({ ok: false, error: /read-only/ });
    await (await actions()).setTheme();
    expect(m.cookiesSet).toEqual(['loop-theme=dark']);
  });
});
