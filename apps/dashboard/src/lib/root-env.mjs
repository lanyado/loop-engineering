// @ts-check
/*
 * The dashboard's settings from the repository's root .env, so one file configures the server and
 * the dashboard. Plain JavaScript: scripts/serve.mjs applies it before Next starts. Only the
 * dashboard's own variables are taken (the root .env also holds MCP_TOKEN and other secrets).
 * Order: the shell, then apps/dashboard/.env.local (older setups keep the dashboard's settings
 * there), then the root .env. The .env.local values are applied here too, not left to Next, because
 * this launcher binds DASHBOARD_HOST/DASHBOARD_PORT before Next reads that file. Empty root values are
 * skipped: .env.example leaves DASHBOARD_AUTH= empty, and that must not turn off a password mode.
 */
import { parseEnv } from 'node:util';

export const DASHBOARD_KEYS = [
  'SERVER_URL',
  'DASHBOARD_TOKEN',
  'DASHBOARD_HOST',
  'DASHBOARD_PORT',
  'DASHBOARD_AUTH',
  'DASHBOARD_PASSWORD',
  'DASHBOARD_SESSION_SECRET',
];

/**
 * @param {string} text contents of the root .env
 * @param {Record<string, string | undefined>} env the current environment
 * @param {string} [localText] contents of apps/dashboard/.env.local, if any
 * @returns {Record<string, string>} the variables to set
 */
export function dashboardEnvFrom(text, env, localText = '') {
  const parsed = parseEnv(text);
  const local = parseEnv(localText);
  /** @type {Record<string, string>} */
  const add = {};
  for (const key of DASHBOARD_KEYS) {
    if (env[key] !== undefined) continue;
    const value = local[key] ?? parsed[key];
    // An empty .env.local value still counts (SERVER_URL= there means demo mode).
    if (value || local[key] !== undefined) add[key] = value ?? '';
  }
  return add;
}
