import { describe, expect, it } from 'vitest';
import { dashboardEnvFrom } from './root-env.mjs';

describe('dashboardEnvFrom', () => {
  const file = [
    '# comment',
    'SERVER_URL=http://127.0.0.1:8787',
    'DASHBOARD_TOKEN=abc123abc123abc123',
    'MCP_TOKEN=not-for-the-dashboard',
    'TELEGRAM_BOT_TOKEN=also-not',
    'DASHBOARD_AUTH=',
  ].join('\n');

  it("takes only the dashboard's variables, and skips empty ones", () => {
    expect(dashboardEnvFrom(file, {})).toEqual({
      SERVER_URL: 'http://127.0.0.1:8787',
      DASHBOARD_TOKEN: 'abc123abc123abc123',
    });
  });

  it('keeps variables already set, even empty ones (SERVER_URL= runs demo mode)', () => {
    expect(dashboardEnvFrom(file, { SERVER_URL: '', DASHBOARD_TOKEN: 'from-shell' })).toEqual({});
  });

  it('lets apps/dashboard/.env.local win over the root .env, so password mode stays on', () => {
    const local = 'DASHBOARD_AUTH=password\nSERVER_URL=http://127.0.0.1:9999\n';
    const withAuth = `${file}\nDASHBOARD_AUTH=`;
    expect(dashboardEnvFrom(withAuth, {}, local)).toEqual({
      DASHBOARD_AUTH: 'password',
      SERVER_URL: 'http://127.0.0.1:9999',
      DASHBOARD_TOKEN: 'abc123abc123abc123',
    });
    // SERVER_URL= in .env.local means demo mode, so the root value stays out.
    expect(dashboardEnvFrom(file, {}, 'SERVER_URL=\n')).toMatchObject({ SERVER_URL: '' });
    // The launcher binds the port itself, so a .env.local port must reach it.
    expect(dashboardEnvFrom('DASHBOARD_PORT=3757\n', {}, 'DASHBOARD_PORT=4000\n')).toEqual({
      DASHBOARD_PORT: '4000',
    });
  });
});
