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

  it('leaves what apps/dashboard/.env.local sets to Next, so password mode stays on', () => {
    const local = 'DASHBOARD_AUTH=password\nSERVER_URL=http://127.0.0.1:9999\n';
    const withAuth = `${file}\nDASHBOARD_AUTH=`;
    expect(dashboardEnvFrom(withAuth, {}, local)).toEqual({ DASHBOARD_TOKEN: 'abc123abc123abc123' });
  });
});
