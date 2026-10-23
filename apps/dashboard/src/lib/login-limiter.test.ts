import { describe, expect, it } from 'vitest';
import { clientIp, LoginLimiter } from './login-limiter';

const MIN = 60_000;

function limiter() {
  let now = 0;
  const l = new LoginLimiter({ perIp: 5, global: 10, windowMs: 15 * MIN, lockMs: 15 * MIN }, () => now);
  return { l, advance: (ms: number) => (now += ms) };
}

describe('LoginLimiter', () => {
  it('locks an IP out after 5 failures for 15 minutes', () => {
    const { l, advance } = limiter();
    for (let i = 0; i < 4; i++) l.fail('1.1.1.1');
    expect(l.check('1.1.1.1')).toEqual({ allowed: true });
    l.fail('1.1.1.1');
    expect(l.check('1.1.1.1')).toEqual({ allowed: false, retryAfterMs: 15 * MIN });
    expect(l.check('2.2.2.2')).toEqual({ allowed: true });
    advance(15 * MIN);
    expect(l.check('1.1.1.1')).toEqual({ allowed: true });
  });

  it('forgets failures older than the window, and a success clears the IP', () => {
    const { l, advance } = limiter();
    for (let i = 0; i < 4; i++) l.fail('1.1.1.1');
    advance(15 * MIN + 1);
    l.fail('1.1.1.1');
    expect(l.check('1.1.1.1').allowed).toBe(true);
    for (let i = 0; i < 3; i++) l.fail('1.1.1.1');
    l.succeed('1.1.1.1');
    l.fail('1.1.1.1');
    expect(l.check('1.1.1.1').allowed).toBe(true);
  });

  it('locks everyone out after 10 failures from anywhere', () => {
    const { l, advance } = limiter();
    for (let i = 0; i < 10; i++) l.fail(`10.0.0.${i}`);
    expect(l.check('192.168.1.1')).toEqual({ allowed: false, retryAfterMs: 15 * MIN });
    advance(5 * MIN);
    expect(l.check('192.168.1.1')).toEqual({ allowed: false, retryAfterMs: 10 * MIN });
    advance(10 * MIN);
    expect(l.check('192.168.1.1').allowed).toBe(true);
  });

  it('reads the client IP from the platform headers', () => {
    const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
    expect(clientIp(h({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
    expect(clientIp(h({ 'x-real-ip': '203.0.113.8' }))).toBe('203.0.113.8');
    expect(clientIp(h({}))).toBe('unknown');
  });
});
