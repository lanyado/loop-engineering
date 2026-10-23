import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root: this file sits in apps/server/src (sources) or apps/server/dist (build). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Loads REPO_ROOT/.env into process.env if it exists; variables already set win. Returns whether it loaded. */
export function loadRootEnv(root = REPO_ROOT): boolean {
  try {
    process.loadEnvFile(resolve(root, '.env'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Resolves a relative path (e.g. LOOP_DB_PATH=./data/loop.db) against the repo root. */
export function fromRoot(path: string, root = REPO_ROOT): string {
  return path === ':memory:' || isAbsolute(path) ? path : resolve(root, path);
}
