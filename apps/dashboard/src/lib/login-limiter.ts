export interface LoginLimits {
  /** Failures from one IP within `windowMs` that lock that IP out. */
  perIp: number;
  /** Failures from all IPs together within `windowMs` that lock everyone out. */
  global: number;
  windowMs: number;
  lockMs: number;
}

export const DEFAULT_LOGIN_LIMITS: LoginLimits = {
  perIp: 5,
  global: 10,
  windowMs: 15 * 60_000,
  lockMs: 15 * 60_000,
};

const MAX_TRACKED_IPS = 10_000;

export type LoginCheck = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * Throttles password guessing on top of the per-attempt PBKDF2 cost and delay: an IP is locked
 * out after `perIp` failures, and every login after `global` failures from anywhere (which also
 * stops a guesser spreading over many IPs, at the price of locking the owner out for a while).
 *
 * State is in memory, so on Vercel it is per function instance; Vercel's deployment protection
 * (or a firewall rate-limit rule on POST /login) is the outer layer there.
 */
export class LoginLimiter {
  private readonly ips = new Map<string, { failures: number[]; lockedUntil: number }>();
  private globalFailures: number[] = [];
  private globalLockedUntil = 0;

  constructor(
    private readonly limits: LoginLimits = DEFAULT_LOGIN_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  check(ip: string): LoginCheck {
    const now = this.now();
    const until = Math.max(this.globalLockedUntil, this.ips.get(ip)?.lockedUntil ?? 0);
    return until > now ? { allowed: false, retryAfterMs: until - now } : { allowed: true };
  }

  fail(ip: string): void {
    const now = this.now();
    const since = now - this.limits.windowMs;
    this.prune(now);
    const entry = this.ips.get(ip) ?? { failures: [], lockedUntil: 0 };
    entry.failures = [...entry.failures.filter((t) => t > since), now];
    if (entry.failures.length >= this.limits.perIp) {
      entry.lockedUntil = now + this.limits.lockMs;
      entry.failures = [];
    }
    this.ips.set(ip, entry);
    this.globalFailures = [...this.globalFailures.filter((t) => t > since), now];
    if (this.globalFailures.length >= this.limits.global) {
      this.globalLockedUntil = now + this.limits.lockMs;
      this.globalFailures = [];
    }
  }

  /** A correct password clears that IP's failures (not a lock, which check() enforces first). */
  succeed(ip: string): void {
    this.ips.delete(ip);
  }

  private prune(now: number): void {
    const since = now - this.limits.windowMs;
    for (const [ip, entry] of this.ips) {
      if (entry.lockedUntil <= now && entry.failures.every((t) => t <= since)) this.ips.delete(ip);
    }
    // Under a flood of distinct IPs, forget the oldest; the global counter still applies.
    while (this.ips.size >= MAX_TRACKED_IPS) {
      const oldest = this.ips.keys().next().value;
      if (oldest === undefined) break;
      this.ips.delete(oldest);
    }
  }
}

/** The client IP as the platform reports it (Vercel sets x-forwarded-for itself). */
export function clientIp(headers: { get(name: string): string | null }): string {
  return (
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip')?.trim() || 'unknown'
  );
}
