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

  it("takes only the dashboard's variables", () => {
    expect(dashboardEnvFrom(file, {})).toEqual({
      SERVER_URL: 'http://127.0.0.1:8787',
      DASHBOARD_TOKEN: 'abc123abc123abc123',
      DASHBOARD_AUTH: '',
    });
  });

  it('keeps variables already set, even empty ones (SERVER_URL= runs demo mode)', () => {
    expect(dashboardEnvFrom(file, { SERVER_URL: '', DASHBOARD_TOKEN: 'from-shell' })).toEqual({
      DASHBOARD_AUTH: '',
    });
  });
});
