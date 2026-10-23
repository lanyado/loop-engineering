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
const children = parts.map(({ name, cwd, args }) => {
  const child = spawn(process.execPath, args, { cwd, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (code) exitCode = code;
    const running = children.filter((c) => c.exitCode === null && c.signalCode === null);
    if (running.length > 0) {
      console.error(`[start] ${name} stopped (${signal ?? `exit ${code}`}); stopping the rest`);
      for (const c of running) c.kill('SIGTERM');
    } else process.exit(exitCode);
  });
  return child;
});
// Ctrl-C already reaches the children (same process group); a second SIGINT would cut the server's
// clean shutdown short, so only SIGTERM and SIGHUP are passed on.
process.on('SIGINT', () => {});
for (const signal of /** @type {const} */ (['SIGTERM', 'SIGHUP'])) {
  process.on(signal, () => children.forEach((c) => c.kill(signal)));
}
