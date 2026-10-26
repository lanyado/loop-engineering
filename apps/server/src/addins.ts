import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError } from './config.js';
import type { ServerModule } from './context.js';

/** What a local add-in's built entry (local/dist/index.js) exports. */
export interface AddinEntry {
  /** The modules it adds to the server, configured from the environment (.env). */
  serverModules(env: NodeJS.ProcessEnv): ServerModule[] | Promise<ServerModule[]>;
}

/**
 * The owner's private add-ins: a `local/` folder in the repo (gitignored, with its own package.json
 * and build) whose `dist/index.js` exports serverModules(env). Extra channels or integrations live
 * there without being part of this repository. No folder (or no build): none.
 */
export async function loadAddins(dir: string, env: NodeJS.ProcessEnv): Promise<ServerModule[]> {
  const entry = join(dir, 'dist', 'index.js');
  if (!existsSync(entry)) return [];
  const loaded = (await import(pathToFileURL(entry).href)) as Partial<AddinEntry>;
  if (typeof loaded.serverModules !== 'function')
    throw new ConfigError(`${entry} must export serverModules(env)`);
  return loaded.serverModules(env);
}
