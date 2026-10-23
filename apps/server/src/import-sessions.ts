import { loadRootEnv } from './env.js';
import { runImportCli } from './import-cli.js';

// `npm run import-sessions -w @loop-engineering/server -- --project <name>`. Reads REPO_ROOT/.env for
// LOOP_DB_PATH and the secrets to mask, like the server. No network.
loadRootEnv();
process.exitCode = await runImportCli(process.argv.slice(2), {
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
