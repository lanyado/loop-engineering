import { runLoopCli } from './loop-cli.js';
import { cliGit } from './cli-git.js';
import { loadRootEnv } from './env.js';

// `loop init` (scripts/loop.mjs, after `npm link` at the repo root) or `npm run loop -- init <path>`.
// Reads REPO_ROOT/.env for SERVER_URL and DASHBOARD_TOKEN, like the server, from whatever folder it runs in.
loadRootEnv();
process.exitCode = await runLoopCli(process.argv.slice(2), {
  env: process.env,
  git: (args, cwd) => cliGit(args, cwd),
  fetch,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
