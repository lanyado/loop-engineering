/*
 * Viewer sessions: one shared password (DASHBOARD_PASSWORD) buys a signed, httpOnly cookie.
 *
 * Cookie value: "v1.<expiresAtMs>.<base64url HMAC-SHA256 of 'v1.<expiresAtMs>'>", keyed by
 * DASHBOARD_SESSION_SECRET (random, required in production), so a stolen cookie says nothing about
 * the password. Rotating the secret is how to sign every viewer out (there is no per-cookie revoke).
 * Web Crypto only, so this runs the same in the proxy and in actions.
 */

export const SESSION_COOKIE = 'loop_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Shorter passwords are refused at login: a phone-friendly passphrase is still long enough. */
export const MIN_PASSWORD_LENGTH = 12;
export const MIN_SECRET_LENGTH = 32;
/** OWASP's 2023 figure for PBKDF2-HMAC-SHA256: every login attempt costs the server this much work. */
export const PBKDF2_ITERATIONS = 600_000;

const VERSION = 'v1';
const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function signingKey(secret: string): Promise<CryptoKey> {
  // Domain-separate the key so the raw password is never used as an HMAC key elsewhere.
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`loop-dashboard-session\0${secret}`));
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function createSessionToken(secret: string, nowMs: number): Promise<string> {
  const payload = `${VERSION}.${nowMs + SESSION_TTL_MS}`;
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(payload));
  return `${payload}.${base64url(signature)}`;
}

export async function verifySessionToken(
  secret: string,
  token: string | undefined,
  nowMs: number,
): Promise<boolean> {
  if (!token || token.length > 200) return false;
  const [version, expires, signature, ...rest] = token.split('.');
  if (version !== VERSION || !expires || !signature || rest.length > 0) return false;
  if (!/^\d{1,16}$/.test(expires) || Number(expires) <= nowMs) return false;
  const bytes = fromBase64url(signature);
  if (!bytes) return false;
  // subtle.verify compares in constant time.
  return crypto.subtle.verify(
    'HMAC',
    await signingKey(secret),
    bytes,
    encoder.encode(`${version}.${expires}`),
  );
}

async function pbkdf2(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256),
  );
}

// One random salt per process; the expected password's hash is computed once per process.
const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
const expectedHashes = new Map<string, Promise<Uint8Array>>();

/**
 * Password check through PBKDF2 (so each guess is expensive), comparing the derived bytes in
 * constant time; the strings themselves are never compared.
 */
export async function passwordMatches(
  input: string,
  expected: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<boolean> {
  const cacheKey = `${iterations}\0${expected}`;
  let expectedHash = expectedHashes.get(cacheKey);
  if (!expectedHash) {
    expectedHash = pbkdf2(expected, salt, iterations);
    expectedHashes.set(cacheKey, expectedHash);
  }
  const [a, b] = await Promise.all([pbkdf2(input, salt, iterations), expectedHash]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export interface AuthConfig {
  /** Null when login is not configured safely (see problem): nobody can log in. */
  password: string | null;
  /** Key material for the session HMAC. */
  secret: string | null;
  problem: string | null;
}

export function authConfig(env: Record<string, string | undefined>): AuthConfig {
  const password = env.DASHBOARD_PASSWORD ?? '';
  if (password.length === 0) {
    return { password: null, secret: null, problem: 'DASHBOARD_PASSWORD is not set, so nobody can log in.' };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      password: null,
      secret: null,
      problem: `DASHBOARD_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  const secret = env.DASHBOARD_SESSION_SECRET ?? '';
  const production = env.NODE_ENV === 'production' || !!env.VERCEL;
  if (secret.length >= MIN_SECRET_LENGTH) return { password, secret, problem: null };
  if (production || secret.length > 0) {
    // Fail closed: without a strong random secret, cookies could be forged or cracked offline.
    return {
      password: null,
      secret: null,
      problem: `DASHBOARD_SESSION_SECRET must be set to ${MIN_SECRET_LENGTH}+ random characters (e.g. \`openssl rand -hex 32\`).`,
    };
  }
  // Local `next dev` only: a key derived from the password, so no extra setup is needed.
  return { password, secret: `dev-only\0${password}`, problem: null };
}

const ORIGIN = 'https://dashboard.invalid';

/**
 * Where to go after login: a same-origin path only. Control characters and backslashes are refused
 * outright (browsers drop tabs/newlines and read \\ as /, turning "/\t/evil" into "//evil"); what
 * is left must resolve to this origin.
 */
export function safeNextPath(next: unknown): string {
  // eslint-disable-next-line no-control-regex
  if (typeof next !== 'string' || !next.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(next)) return '/';
  let url: URL;
  try {
    url = new URL(next, ORIGIN);
  } catch {
    return '/';
  }
  if (url.origin !== ORIGIN || url.pathname.startsWith('/login')) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Whether the session cookie gets the Secure flag: on over https (directly or behind a proxy that
 * sets x-forwarded-proto), off over plain http, so login works on http://localhost and 127.0.0.1
 * (Safari drops Secure cookies there). Without any hint, Secure only in production.
 */
export function cookieIsSecure(
  get: (name: string) => string | null,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  const forwarded = get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === 'https';
  const origin = get('origin');
  if (origin) return origin.toLowerCase().startsWith('https:');
  return nodeEnv === 'production';
}
