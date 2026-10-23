import type { TimerHandle, Timers } from '@loop-engineering/ask-human';
import { secretValues } from '@loop-engineering/core';
import { registerSearchHistoryTool, TranscriptIngester, type IngestOptions } from '@loop-engineering/history';
import type { ServerContext, ServerModule } from '../context.js';

export interface HistoryModuleOptions {
  /** Passed to the TranscriptIngester (projects folder, fs, caps). */
  ingest?: IngestOptions;
  /** How often paused and ended sessions are checked for new transcripts. Default 60 s. */
  intervalMs?: number;
  log?: (message: string) => void;
}

export type HistoryModule = ServerModule & { ingester(): TranscriptIngester | null };

/**
 * Searchable history: the search_history tool on /mcp (scoped to the caller's project through its
 * X-Loop-Session-Id), and a sweep that stores transcripts of paused and ended sessions. The dashboard's
 * GET /api/history lives with the other dashboard routes (dashboard-api.ts).
 */
export function historyModule(options: HistoryModuleOptions = {}): HistoryModule {
  const log = options.log ?? ((m: string) => console.warn(`[history] ${m}`));
  let ingester: TranscriptIngester | null = null;
  let timers: Timers | null = null;
  let timer: TimerHandle | null = null;
  let sweeping: Promise<unknown> | null = null;

  const loop = () => {
    const current = ingester;
    if (!current) return;
    sweeping = current
      .sweep()
      .catch((err: unknown) => log(`transcript sweep failed: ${String(err)}`))
      .finally(() => {
        sweeping = null;
        if (ingester === current && timers) timer = timers.setTimeout(loop, options.intervalMs ?? 60_000);
      });
  };

  return {
    name: 'history',
    ingester: () => ingester,

    mcp(server, connection, ctx) {
      registerSearchHistoryTool(server, ctx.store, {
        sessionHeader: connection.sessionHeader,
        secrets: secretValues(process.env),
      });
    },

    start(ctx: ServerContext) {
      ingester = new TranscriptIngester(ctx.store, {
        log,
        // The server's own secrets (MCP_TOKEN, bot token, API keys) never land in history.
        secrets: secretValues(process.env),
        ...options.ingest,
      });
      timers = ctx.timers;
      loop();
    },

    async stop() {
      ingester = null;
      if (timer && timers) timers.clearTimeout(timer);
      timer = null;
      await sweeping;
    },
  };
}
