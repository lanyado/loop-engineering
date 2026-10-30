#!/usr/bin/env node
// @ts-check
/*
 * The `loop` command (`npm link` once at the repo root puts it on your PATH): `loop init` in a
 * project's folder gives that project its own pipeline. The code is apps/server/src/loop-cli.ts.
 */
import console from 'node:console';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const built = fileURLToPath(new URL('../apps/server/dist/loop-command.js', import.meta.url));
if (!existsSync(built)) {
  console.error('[loop] not built yet: run `npm run build` in loop-engineering first.');
  process.exit(1);
}
await import(built);
