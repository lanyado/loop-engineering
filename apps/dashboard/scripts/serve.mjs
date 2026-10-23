// @ts-check
/*
 * `npm run dev|start` for the dashboard: reads the dashboard's variables from the root .env, checks
 * DASHBOARD_AUTH against DASHBOARD_HOST before Next starts (one clear line and exit 1 when refused),
 * then runs `next <command> -H <host> -p <port>`.
 * Started any other way, src/instrumentation.ts still refuses an unsafe bind, after Next's banner.
 */
import { spawn } from 'node:child_process';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { URL } from 'node:url';
import { accessConfig, dashboardHost } from '../src/lib/access-rules.mjs';
import { dashboardEnvFrom } from '../src/lib/root-env.mjs';

const [command, ...rest] = process.argv.slice(2);
if (command !== 'dev' && command !== 'start') {
  console.error('[dashboard] usage: serve.mjs dev|start');
  process.exit(2);
}
// The bind comes from DASHBOARD_HOST/DASHBOARD_PORT only, so it is the one that was checked.
if (rest.some((a) => /^(-H|--hostname|-p|--port)(=|$)/.test(a))) {
  console.error('[dashboard] refusing to start: set DASHBOARD_HOST / DASHBOARD_PORT instead of -H / -p.');
  process.exit(1);
}
/** @param {string} path relative to this script */
function readIfThere(path) {
  try {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return '';
    throw error;
  }
}
Object.assign(
  process.env,
  dashboardEnvFrom(readIfThere('../../../.env'), process.env, readIfThere('../.env.local')),
);
const host = dashboardHost(process.env);
const port = (process.env.DASHBOARD_PORT ?? '').trim() || '3737';
const { problem } = accessConfig(process.env);
if (problem) {
  console.error(`[dashboard] refusing to start: ${problem}`);
  process.exit(1);
}

const next = createRequire(import.meta.url).resolve('next/dist/bin/next');
const child = spawn(process.execPath, [next, command, '-H', host, '-p', port, ...rest], {
  stdio: 'inherit',
  env: { ...process.env, DASHBOARD_HOST: host },
});
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
