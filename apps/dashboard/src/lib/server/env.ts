import 'server-only';
import { accessConfig } from '../access';
import { authConfig } from '../auth';
import type { Backend } from '../backend';
import { backendConfig } from '../config';
import { DemoBackend } from '../demo-backend';
import { HttpBackend } from '../http-backend';

/*
 * The only place the dashboard reads its secrets. SERVER_URL and DASHBOARD_TOKEN stay on the
 * server: they are not NEXT_PUBLIC_, and this module cannot be imported by client components.
 */

let cached: { key: string; backend: Backend } | null = null;

/**
 * The backend for this deployment; throws when the configuration is broken. It does NOT check the
 * viewer's login: pages, actions and routes use backendForViewer() / backendIfLoggedIn() from
 * ./session instead (eslint refuses this import under src/app and src/components).
 */
export function backendWithoutLoginCheck(): Backend {
  const config = backendConfig(process.env);
  if (config.kind === 'broken') throw new Error(config.problem);
  const key = config.kind === 'demo' ? 'demo' : `${config.serverUrl}\n${config.token}`;
  if (cached?.key !== key) {
    cached = {
      key,
      backend:
        config.kind === 'demo'
          ? new DemoBackend()
          : new HttpBackend({ serverUrl: config.serverUrl, token: config.token }),
    };
  }
  return cached.backend;
}

export const isDemo = () => backendConfig(process.env).kind === 'demo';

export const getAuthConfig = () => authConfig(process.env);

export const getAccessConfig = () => accessConfig(process.env);

/** True when DASHBOARD_AUTH resolves to none: no login page, no logout button. */
export const noLogin = () => accessConfig(process.env).mode === 'none';
