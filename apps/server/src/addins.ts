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

const REBUILD = 'npm --prefix local install && npm --prefix local run build';

/**
 * The owner's private add-ins: a `local/` folder in the repo (gitignored, with its own package.json
 * and build) whose `dist/index.js` exports serverModules(env). Extra channels or integrations live
 * there without being part of this repository. No folder: none. A folder that is not built: none,
 * with a warning.
 */
export async function loadAddins(
  dir: string,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void = console.log,
): Promise<ServerModule[]> {
  if (!existsSync(dir)) return [];
  const entry = join(dir, 'dist', 'index.js');
  if (!existsSync(entry)) {
    log(`[addins] ${dir} is not built, so it is skipped. Build it: ${REBUILD}`);
    return [];
  }
  let loaded: Partial<AddinEntry>;
  try {
    loaded = (await import(pathToFileURL(entry).href)) as Partial<AddinEntry>;
  } catch (error) {
    // An add-in's own settings error, thrown while loading, speaks for itself.
    if (error instanceof Error && error.name.endsWith('ConfigError')) throw error;
    const why = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Could not load ${entry}: ${why}\nRebuild it: ${REBUILD}`);
  }
  if (typeof loaded.serverModules !== 'function')
    throw new ConfigError(`${entry} must export serverModules(env)`);
  const modules = await loaded.serverModules(env);
  if (!Array.isArray(modules) || modules.some((m) => typeof m?.name !== 'string'))
    throw new ConfigError(`${entry}: serverModules(env) must return an array of modules, each with a name`);
  log(`[addins] loaded ${modules.map((m) => m.name).join(', ') || 'no modules'}`);
  return modules;
}
