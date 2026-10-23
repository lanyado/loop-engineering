/*
 * Who may use the dashboard: DASHBOARD_AUTH=none (no login) or password (the signed-cookie login in
 * ./auth). `none` is the default, and only allowed, while the dashboard listens on loopback only.
 *
 * A login-free page on localhost can still be driven by any website the user visits: a form or
 * fetch posting to http://127.0.0.1:<port> (CSRF), or a hostile domain re-pointed at 127.0.0.1 (DNS
 * rebinding). So `none` mode accepts a request only when its Host is this machine at this port, and
 * a write (any non-GET, every Server Action) only when its Origin is too. Edge-safe: the proxy
 * imports it.
 */

import { accessConfig, dashboardHost, isLoopbackHost } from './access-rules.mjs';

export { accessConfig, dashboardHost, isLoopbackHost };

export type AuthMode = 'none' | 'password';
export type AccessConfig = ReturnType<typeof accessConfig>;

type Env = Record<string, string | undefined>;

/** The port this server listens on: `next start|dev -p` sets PORT in its own process. */
export function listeningPort(env: Env): string {
  return env.PORT || env.DASHBOARD_PORT || '3737';
}

/** The only Host headers `none` mode answers: this machine, at this port. */
export function allowedHosts(port: string): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

export interface LocalRequest {
  method: string;
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
  /** Next sends a Next-Action header with every Server Action call. */
  isAction: boolean;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** The `none`-mode gate for one request (the proxy runs it; pages and actions run it again). */
export function checkLocalRequest(request: LocalRequest, port: string): Verdict {
  const hosts = allowedHosts(port);
  // Exact match: "127.0.0.1.evil.com:<port>" or "evil.com" (DNS rebinding) never pass.
  if (!request.host || !hosts.includes(request.host.toLowerCase())) {
    return { ok: false, reason: 'this dashboard only answers on 127.0.0.1, localhost or [::1]' };
  }
  const write = !['GET', 'HEAD'].includes(request.method.toUpperCase()) || request.isAction;
  if (!write) return { ok: true };
  if (request.origin !== null) {
    return hosts.some((h) => request.origin!.toLowerCase() === `http://${h}`)
      ? { ok: true }
      : { ok: false, reason: 'cross-origin write refused' };
  }
  // Browsers that omit Origin still say where a request came from. Sec-Fetch-Site is a forbidden
  // header (no page script can set it), so this stops browsers only; a non-browser client can send
  // anything. That is safe solely because none mode binds loopback (checked at startup against the
  // real socket, lib/server/startup.ts): only processes on this machine can connect at all.
  if (request.secFetchSite === 'same-origin') return { ok: true };
  return { ok: false, reason: 'a write needs a same-origin Origin header' };
}

/** checkLocalRequest over a Headers object (method given separately: Headers do not carry it). */
export function checkLocalHeaders(method: string, headers: Headers, port: string): Verdict {
  return checkLocalRequest(
    {
      method,
      host: headers.get('host'),
      origin: headers.get('origin'),
      secFetchSite: headers.get('sec-fetch-site'),
      isAction: headers.has('next-action'),
    },
    port,
  );
}
