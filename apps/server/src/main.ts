import { FileStageLibrary } from '@loop-engineering/loop';
import { loadAddins } from './addins.js';
import { ConfigError, describeListenError, loadConfig, nonLocalBindWarning } from './config.js';
import { fromRoot, loadRootEnv, REPO_ROOT } from './env.js';
import { claudeUsageModule } from './modules/claude-usage.js';
import { terminalModule } from './modules/terminal.js';
import { opencodeSubagentsModule } from './modules/opencode-subagents.js';
import { dashboardApi } from './modules/dashboard-api.js';
import { loopModuleFromEnv } from './modules/loop.js';
import { pipelineModule } from './modules/pipeline.js';
import { routerModule } from './modules/router.js';
import { historyModule } from './modules/history.js';
import { plannerModule } from './modules/planner.js';
import { runnerFromEnv } from './runner.js';
import { createServer } from './server.js';

// Entry point: `npm start` at the repo root runs it with the dashboard (`npm run start:server` alone),
// after `npm run build`. Reads REPO_ROOT/.env whatever the working directory, and resolves a relative
// LOOP_DB_PATH against the repo root too.
loadRootEnv();

// The PR loop's stage files: the user's versions and new stages (the built-ins ship in packages/loop/stages).
const stages = new FileStageLibrary(fromRoot(process.env.STAGES_DIR?.trim() || 'data/stages'));

let config;
let loop;
let runner;
let addins;
try {
  config = loadConfig();
  // Every session agent plans each new task first, following planner.md as it reads at launch.
  runner = runnerFromEnv(process.env, config, { planner: () => stages.planner().prompt });
  loop = loopModuleFromEnv(process.env, { stages });
  // Private add-ins from local/ (see addins.ts); one that is set up wrong stops the start, like the rest.
  addins = await loadAddins(fromRoot('local'), process.env);
} catch (error) {
  if (!(error instanceof Error)) throw error;
  if (!(error instanceof ConfigError) && !error.name.endsWith('ConfigError')) throw error;
  console.error(error.message);
  process.exit(1);
}

const bindWarning = nonLocalBindWarning(config.host);
if (bindWarning) console.warn(`\n!!! ${bindWarning} (allowed by ALLOW_NON_LOCAL_BIND=on) !!!\n`);

const server = createServer({
  config: { ...config, dbPath: fromRoot(config.dbPath) },
  // The one SessionRunner and usage-limit monitor, shared by the PR loop and the router.
  ...(runner ? { runner } : {}),
  // The router comes after the add-ins (which may add question channels), so they are listening when
  // it asks a routing question, and before the loop, so it hears the loop's fix requests. It stays off
  // without ctx.runner. History and the planner come last: they only add MCP tools (and a sweep).
  modules: [
    dashboardApi(),
    pipelineModule({ stages, poke: () => loop?.engine()?.poke() }),
    claudeUsageModule(),
    terminalModule(),
    opencodeSubagentsModule(),
    ...addins,
    routerModule(),
    ...(loop ? [loop] : []),
    historyModule(),
    plannerModule(),
  ],
});
// Registered before start(), so the server can always be stopped, even while it is starting.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(`[server] ${signal}: shutting down`);
    void server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('[server] shutdown failed:', error);
        process.exit(1);
      },
    );
  });
}

if (!runner)
  console.warn('[runner] sessions are off: set WORKTREES_ROOT in .env (`npm run setup` does this)');
if (!loop) console.log('[loop] PR loop off (set LOOP_ENGINE=on to run it)');
let bound;
try {
  bound = await server.start();
} catch (error) {
  console.error(`[server] ${describeListenError(error, config.host, config.port)}`);
  process.exit(1);
}
console.log(
  `[server] listening on ${bound.url} (bound ${bound.address}:${bound.port} for SERVER_HOST=${config.host}; public URL: ${config.publicUrl ?? 'not set'}, repo: ${REPO_ROOT})`,
);
