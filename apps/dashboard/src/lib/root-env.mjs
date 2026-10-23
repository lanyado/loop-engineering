// @ts-check
/*
 * The dashboard's settings from the repository's root .env, so one file configures the server and
 * the dashboard. Plain JavaScript: scripts/serve.mjs applies it before Next starts. Only the
 * dashboard's own variables are taken (the root .env also holds MCP_TOKEN, the Telegram token, ...),
 * and variables already set in the environment win, as with the server.
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
 * @returns {Record<string, string>} the variables to add
 */
export function dashboardEnvFrom(text, env) {
  const parsed = parseEnv(text);
  /** @type {Record<string, string>} */
  const add = {};
  for (const key of DASHBOARD_KEYS) {
    const value = parsed[key];
    if (env[key] === undefined && value !== undefined) add[key] = value;
  }
  return add;
}
