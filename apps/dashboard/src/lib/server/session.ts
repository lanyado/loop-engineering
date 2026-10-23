import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { checkLocalHeaders, listeningPort } from '../access';
import { SESSION_COOKIE, verifySessionToken } from '../auth';
import type { Backend } from '../backend';
import { backendWithoutLoginCheck, getAccessConfig, getAuthConfig } from './env';

/** Thrown when a `none`-mode request fails the Host/Origin check (the proxy normally 403s first). */
export class ForbiddenRequestError extends Error {}

/**
 * Whether this request may see data. DASHBOARD_AUTH=none: no login, but the request must be for
 * this machine (Host) and, for a Server Action, from this origin. password: a valid session cookie.
 */
export async function isLoggedIn(): Promise<boolean> {
  // Read the request first: it makes the caller request-time, so the env is read per request
  // rather than baked in at build.
  const requestHeaders = await headers();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const access = getAccessConfig();
  if (access.problem) return false;
  if (access.mode === 'none') {
    // Pages are GETs; a Server Action (Next-Action header) is checked as the write it is.
    const method = requestHeaders.has('next-action') ? 'POST' : 'GET';
    return checkLocalHeaders(method, requestHeaders, listeningPort(process.env)).ok;
  }
  const { secret } = getAuthConfig();
  if (!secret) return false;
  return verifySessionToken(secret, token, Date.now());
}

/** Redirects to /login unless the request may see data; in `none` mode, throws instead. */
export async function requireLogin(): Promise<void> {
  if (await isLoggedIn()) return;
  if (getAccessConfig().mode === 'none') throw new ForbiddenRequestError('Forbidden');
  redirect('/login');
}

/**
 * The only way pages and Server Actions get data: the access check comes first, every time. The
 * proxy already filters requests, but layouts don't re-run on client navigation and actions are
 * plain POST endpoints (reachable on any route, /login included), so each checks itself.
 */
export async function backendForViewer(): Promise<Backend> {
  await requireLogin();
  return backendWithoutLoginCheck();
}

/** For route handlers that answer 401 instead of redirecting. */
export async function backendIfLoggedIn(): Promise<Backend | null> {
  return (await isLoggedIn()) ? backendWithoutLoginCheck() : null;
}
