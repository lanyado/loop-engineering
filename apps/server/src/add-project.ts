import { execFileSync } from 'node:child_process';
import { runAddProjectCli } from './add-project-cli.js';
import { loadRootEnv } from './env.js';

// `npm run add-project -- <path>`. Reads REPO_ROOT/.env for SERVER_URL and DASHBOARD_TOKEN, like the server.
loadRootEnv();
process.exitCode = await runAddProjectCli(process.argv.slice(2), {
  env: process.env,
  git: (args, cwd) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  },
  fetch,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
