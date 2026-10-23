import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// scripts/serve.mjs refuses an unsafe setup before Next starts: one line on stderr, exit 1, and
// nothing from Next (no "Ready", no Network URL). Only refusals are run here: they never start Next.
const script = fileURLToPath(new URL('../../scripts/serve.mjs', import.meta.url));

function serve(args: string[], env: Record<string, string>) {
  const clean = { ...process.env };
  for (const name of [
    'DASHBOARD_HOST',
    'DASHBOARD_AUTH',
    'DASHBOARD_PASSWORD',
    'DASHBOARD_SESSION_SECRET',
    'VERCEL',
  ])
    delete clean[name];
  return spawnSync(process.execPath, [script, ...args], {
    env: { ...clean, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

describe('scripts/serve.mjs', () => {
  it('refuses a non-loopback DASHBOARD_HOST without password auth, before Next starts', () => {
    for (const host of ['0.0.0.0', '192.168.1.20', '::']) {
      for (const command of ['start', 'dev']) {
        const result = serve([command], { DASHBOARD_HOST: host, DASHBOARD_PORT: '3990' });
        expect(result.status, `${command} ${host}`).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
        expect(result.stderr).toMatch(/^\[dashboard\] refusing to start: .*DASHBOARD_AUTH=password/);
      }
    }
  });

  it('refuses password mode on a network host without its password and secret', () => {
    const result = serve(['start'], { DASHBOARD_HOST: '0.0.0.0', DASHBOARD_AUTH: 'password' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/DASHBOARD_PASSWORD is not set/);
  });

  it('refuses -H / -p passed through npm, which would bypass the checked DASHBOARD_HOST', () => {
    for (const extra of [['-H', '0.0.0.0'], ['--hostname=0.0.0.0'], ['-p', '80']]) {
      const result = serve(['start', ...extra], {});
      expect(result.status, extra.join(' ')).toBe(1);
      expect(result.stderr).toMatch(/set DASHBOARD_HOST/);
    }
  });
});
