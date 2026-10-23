// @ts-check
/*
 * DASHBOARD_AUTH resolution, in plain JavaScript so the npm launcher (scripts/serve.mjs) can run
 * it before Next starts, and the app (lib/access.ts) imports the very same rules.
 *
 * none (no login) is the default, and only allowed, while the dashboard binds loopback only. Any
 * other host, and Vercel, needs DASHBOARD_AUTH=password with a password and a real session secret.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
// Same limits as lib/auth.ts, which keeps enforcing them at login.
const MIN_PASSWORD_LENGTH = 12;
const MIN_SECRET_LENGTH = 32;

/** @param {Record<string, string | undefined>} env */
export function dashboardHost(env) {
  return (env.DASHBOARD_HOST ?? '').trim() || '127.0.0.1';
}

/** @param {string} host */
export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ mode: 'none' | 'password' | null, problem: string | null }}
 */
export function accessConfig(env) {
  const host = dashboardHost(env);
  // A Vercel deployment is reachable from the internet whatever DASHBOARD_HOST says.
  const local = isLoopbackHost(host) && !env.VERCEL;
  const raw = (env.DASHBOARD_AUTH ?? '').trim().toLowerCase();
  if (raw !== '' && raw !== 'none' && raw !== 'password') {
    return { mode: null, problem: `DASHBOARD_AUTH must be "none" or "password", not "${raw}".` };
  }
  if (local) return { mode: raw === 'password' ? 'password' : 'none', problem: null };

  const where = env.VERCEL ? 'On Vercel' : `${host} is not a loopback address, so`;
  if (raw !== 'password') {
    return {
      mode: null,
      problem: `${where} the dashboard needs DASHBOARD_AUTH=password with DASHBOARD_PASSWORD and DASHBOARD_SESSION_SECRET.`,
    };
  }
  const password = env.DASHBOARD_PASSWORD ?? '';
  if (password.length === 0)
    return { mode: null, problem: 'DASHBOARD_PASSWORD is not set, so nobody can log in.' };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { mode: null, problem: `DASHBOARD_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  // lib/auth.ts lets local `next dev` run without a secret; a network-reachable dashboard may not.
  if ((env.DASHBOARD_SESSION_SECRET ?? '').length < MIN_SECRET_LENGTH) {
    return {
      mode: null,
      problem: `${where} DASHBOARD_SESSION_SECRET must be set to ${MIN_SECRET_LENGTH}+ random characters.`,
    };
  }
  return { mode: 'password', problem: null };
}
