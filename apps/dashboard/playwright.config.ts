import { defineConfig } from '@playwright/test';
import { E2E } from './e2e/env';

// Needs a build first: `npm run test:e2e` at the repo root builds, then runs this.
// Three dashboards from the same build: one in demo mode (no SERVER_URL), one wired to a real
// server (e2e/live-server.mjs) on a temp SQLite file, both with the loopback default
// DASHBOARD_AUTH=none (no login), each at desktop width (the dashboard is used on a computer only); and one in demo mode with
// DASHBOARD_AUTH=password, so the login path stays covered.
const desktop = { viewport: { width: 1280, height: 860 } };

const nextStart = (port: number, env: Record<string, string>) => ({
  command: `npx next start -H 127.0.0.1 -p ${port}`,
  url: `http://localhost:${port}/login`,
  reuseExistingServer: false,
  timeout: 60_000,
  env: {
    NEXT_TELEMETRY_DISABLED: '1',
    DASHBOARD_HOST: '127.0.0.1',
    // Empty: the loopback default (none). Password variables are cleared so none mode is shown
    // to need none of them.
    DASHBOARD_AUTH: '',
    DASHBOARD_PASSWORD: '',
    DASHBOARD_SESSION_SECRET: '',
    ...env,
  },
});

export default defineConfig({
  testDir: 'e2e',
  // Exactly one worker: the live-* projects share one server and SQLite file, and every live test
  // resets that data first, so two workers would reset each other's data mid-test. One worker also
  // keeps CPU use low. (Per-worker servers would lift this; not needed at this suite's ~20 s.)
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { browserName: 'chromium', trace: 'retain-on-failure' },
  projects: [
    { name: 'demo-desktop', testMatch: /demo\.spec\.ts/, use: { ...desktop, baseURL: E2E.demoUrl } },
    { name: 'live-desktop', testMatch: /live\.spec\.ts/, use: { ...desktop, baseURL: E2E.liveUrl } },
    {
      name: 'password-desktop',
      testMatch: /password\.spec\.ts/,
      use: { ...desktop, baseURL: E2E.passwordUrl },
    },
  ],
  webServer: [
    {
      command: 'node e2e/live-server.mjs',
      url: `${E2E.serverUrl}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        LIVE_PORT: String(E2E.serverPort),
        DASHBOARD_TOKEN: E2E.dashboardToken,
        MCP_TOKEN: E2E.mcpToken,
      },
    },
    nextStart(E2E.demoPort, { SERVER_URL: '' }),
    nextStart(E2E.livePort, { SERVER_URL: E2E.serverUrl, DASHBOARD_TOKEN: E2E.dashboardToken }),
    nextStart(E2E.passwordPort, {
      SERVER_URL: '',
      DASHBOARD_AUTH: 'password',
      DASHBOARD_PASSWORD: E2E.password,
      DASHBOARD_SESSION_SECRET: E2E.sessionSecret,
    }),
  ],
});
