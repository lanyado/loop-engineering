import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The bearer token of one session on /mcp: HMAC-SHA256(MCP_TOKEN, "session:<id>"), hex. The runner
 * gives each agent only its own token, so an agent cannot act as another session (or read another
 * project's history) by changing the X-Loop-Session-Id header.
 */
export function sessionToken(secret: string, sessionId: number): string {
  return createHmac('sha256', secret).update(`session:${sessionId}`).digest('hex');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True when `token` is the session token of `sessionId` under `secret`. */
export function verifySessionToken(secret: string, sessionId: number, token: string): boolean {
  return safeEqual(sessionToken(secret, sessionId), token);
}
