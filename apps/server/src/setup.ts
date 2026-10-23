import { accessSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { REPO_ROOT } from './env.js';
import { runSetup } from './setup-cli.js';

// `npm run setup` (after its build step). Writes REPO_ROOT/.env; no network.
function onPath(command: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

process.exitCode = runSetup({
  root: REPO_ROOT,
  home: homedir(),
  nodeVersion: process.versions.node,
  onPath,
  randomToken: () => randomBytes(32).toString('hex'),
  out: (line) => console.log(line),
});
