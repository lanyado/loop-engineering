import { runAddProjectCli } from './add-project-cli.js';
import { cliGit } from './cli-git.js';
import { loadRootEnv } from './env.js';

// `npm run add-project -- <path>`. Reads REPO_ROOT/.env for SERVER_URL and DASHBOARD_TOKEN, like the server.
loadRootEnv();
process.exitCode = await runAddProjectCli(process.argv.slice(2), {
  env: process.env,
  git: (args, cwd) => cliGit(args, cwd),
  fetch,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
