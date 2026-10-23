// @ts-check
/*
 * `npm start`: the server and the dashboard together, both reading the root .env. Ctrl-C stops both,
 * and when one exits the other is stopped too.
 */
import { spawn } from 'node:child_process';
import console from 'node:console';
import { existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const root = fileURLToPath(new URL('..', import.meta.url));
const parts = [
  { name: 'server', cwd: root, args: ['apps/server/dist/main.js'], built: 'apps/server/dist/main.js' },
  // Next takes its project folder from the working directory.
  {
    name: 'dashboard',
    cwd: `${root}apps/dashboard`,
    args: ['scripts/serve.mjs', 'start'],
    built: 'apps/dashboard/.next/BUILD_ID',
  },
];
if (parts.some((p) => !existsSync(`${root}${p.built}`))) {
  console.error(
    '[start] not built yet: run `npm run setup` the first time, or `npm run build` after an update.',
  );
  process.exit(1);
}

let exitCode = 0;
let stopping = false;
/** @param {NodeJS.Signals} signal */
function stopAll(signal) {
  stopping = true;
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill(signal);
}
const children = parts.map(({ name, cwd, args }) => {
  const child = spawn(process.execPath, args, { cwd, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    // A crash or a kill we did not ask for is a failure, even when it carries no exit code.
    if (code || (signal && !stopping)) exitCode = code || 1;
    if (!stopping) {
      console.error(`[start] ${name} stopped (${signal ?? `exit ${code}`}); stopping the rest`);
      stopAll('SIGTERM');
    }
    if (children.every((c) => c.exitCode !== null || c.signalCode !== null)) process.exit(exitCode);
  });
  return child;
});
// Ctrl-C also reaches the children directly (same process group). Passing it on as SIGTERM is safe
// (the server's shutdown runs once) and covers a SIGINT sent to this process alone.
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
  process.on(signal, () => stopAll(signal === 'SIGINT' ? 'SIGTERM' : signal));
}
