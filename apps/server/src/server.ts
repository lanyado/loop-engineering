import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import {
  createAskHumanMcpHandler,
  DeadlineSweeper,
  QuestionBus,
  QuestionService,
  RequestService,
  systemTimers,
  type Timers,
} from '@loop-engineering/ask-human';
import { openStore, type Store } from '@loop-engineering/core';
import { trustQuestion, UsageLimitMonitor, type SessionRunner } from '@loop-engineering/runner';
import type { Hono } from 'hono';
import { createApp } from './app.js';
import type { ServerConfig } from './config.js';
import type { ServerContext, ServerModule } from './context.js';

export interface CreateServerOptions {
  config: ServerConfig;
  /** Use this store (and its clock) instead of opening config.dbPath; the caller closes it. */
  store?: Store;
  /** Timers for deadlines and MCP heartbeats; FakeTimers in tests. Default: real timers. */
  timers?: Timers;
  modules?: ServerModule[];
  /** ask_human progress heartbeat interval. Default 25s. */
  mcpHeartbeatMs?: number;
  /** SSE keepalive comment interval for /api/events. Default 15s. */
  sseKeepAliveMs?: number;
  /**
   * How long start() waits for each module's start() before moving on (it keeps running in the
   * background, and a later failure is logged). Default 10s.
   */
  moduleStartTimeoutMs?: number;
  /** Server-level log lines (module start timeouts and failures). Default console.error. */
  log?: (message: string) => void;
  /**
   * Builds the server's one SessionRunner (ctx.runner) from its store; omitted, ctx.runner is null.
   * Every module that drives sessions (the PR loop, the router) shares it, so its per-session lock
   * covers them all.
   */
  runner?: (store: Store) => SessionRunner;
  /** Run the runner's usage-limit monitor (reconcile + OpenCode fallback) while started. Default true. */
  usageMonitor?: boolean;
}

export interface LoopServer {
  app: Hono;
  ctx: ServerContext;
  /**
   * Listens, starts the modules, then the deadline sweeper, and resolves with the bound URL. A
   * module that takes longer than moduleStartTimeoutMs is left starting in the background, so a
   * module stuck on the network can never keep questions from defaulting.
   */
  start(): Promise<{ url: string; port: number; address: string }>;
  /**
   * Stops modules, the sweeper and the HTTP server. Callers blocked in ask_human lose their
   * connection; their questions stay pending in SQLite for the next start to answer or default.
   */
  close(): Promise<void>;
}

export function createServer(options: CreateServerOptions): LoopServer {
  const { config } = options;
  const ownsStore = !options.store;
  if (ownsStore && config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = options.store ?? openStore({ path: config.dbPath });
  const timers = options.timers ?? systemTimers;
  const bus = new QuestionBus();
  const questions = new QuestionService(store, bus);
  const sweeper = new DeadlineSweeper(questions, { timers });
  const shutdown = new AbortController();
  const modules = options.modules ?? [];
  const log = options.log ?? ((message: string) => console.error(message));
  const moduleStartTimeoutMs = options.moduleStartTimeoutMs ?? 10_000;
  const ctx: ServerContext = {
    config,
    store,
    clock: store.clock,
    timers,
    bus,
    questions,
    requests: new RequestService(store, bus),
    runner: options.runner ? options.runner(store) : null,
    sweeper,
    shutdown: shutdown.signal,
  };
  const mcp = createAskHumanMcpHandler(questions, {
    timers,
    heartbeatMs: options.mcpHeartbeatMs ?? 25_000,
    onerror: (error) => console.error('[mcp]', error),
    tools: modules.flatMap((m) => (m.mcp ? [(server, connection) => m.mcp?.(server, connection, ctx)] : [])),
  });
  const app = createApp(ctx, { mcp, modules, sseKeepAliveMs: options.sseKeepAliveMs ?? 15_000 });
  // One monitor for the one runner: two would race to fall the same session back to OpenCode.
  const monitor =
    ctx.runner && options.usageMonitor !== false
      ? new UsageLimitMonitor(ctx.runner, store, {
          onError: (error, sessionId) =>
            log(`[runner] monitor (session ${String(sessionId)}): ${String(error)}`),
          onModelRotated: (session, why) =>
            log(`[runner] session ${session.id} moved to ${session.model}: ${why}`),
          // Builders paused at Claude's usage limit are tried on Claude again every half hour.
          retryClaudeLimitMs: 30 * 60_000,
          onLimitResumed: (session) =>
            log(`[runner] session ${session.id} resumed on Claude after its usage limit`),
          // Nobody watches the tmux window, so a session stuck at Claude's trust dialog is asked about.
          onTrustPrompt: (session, folder) => {
            try {
              questions.ask({
                sessionId: session.id,
                ...trustQuestion(session.id, session.tmuxTarget ?? '', folder, store.clock.now()),
              });
            } catch (error) {
              log(`[runner] trust prompt question (session ${session.id}): ${String(error)}`);
            }
          },
        })
      : null;
  let http: ServerType | null = null;
  let started: Promise<{ url: string; port: number; address: string }> | null = null;
  let closed: Promise<void> | null = null;

  const listen = () =>
    new Promise<{ url: string; port: number; address: string }>((resolve, reject) => {
      const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
        resolve({ url: urlOf(info, config.host), port: info.port, address: info.address });
      });
      server.once('error', reject);
      http = server;
    });

  return {
    app,
    ctx,
    start() {
      started ??= (async () => {
        if (config.allowSharedMcpToken) {
          log(
            '[server] WARNING: MCP_ALLOW_SHARED_TOKEN=on. /mcp accepts the shared MCP_TOKEN, so any agent ' +
              'holding it can act as any session and read any project history. Use only for manual testing.',
          );
        }
        const bound = await listen();
        monitor?.start();
        for (const module of modules) await startModule(module, ctx, moduleStartTimeoutMs, log);
        // After the modules, so questions that came due while the server was down are defaulted
        // with every channel listening, and each channel can announce the default. Modules only
        // delay this by their bounded start, never indefinitely.
        sweeper.start();
        return bound;
      })();
      return started;
    },
    close() {
      closed ??= (async () => {
        // In reverse order, one at a time; a module that fails to stop never blocks the rest.
        for (const module of [...modules].reverse()) {
          try {
            await module.stop?.();
          } catch (error) {
            log(`[server] module ${module.name} failed to stop: ${String(error)}`);
          }
        }
        monitor?.stop();
        sweeper.stop();
        shutdown.abort();
        await mcp.close();
        if (http) {
          const server = http;
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
            if ('closeAllConnections' in server) server.closeAllConnections();
          });
        }
        if (ownsStore) store.close();
      })();
      return closed;
    },
  };
}

/**
 * Runs module.start, waiting at most `timeoutMs`. A start that fails within the wait fails the
 * server start (a broken config should be loud); one still running after it is logged and left to
 * finish in the background, with a later failure logged too.
 */
async function startModule(
  module: ServerModule,
  ctx: ServerContext,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<void> {
  if (!module.start) return;
  const starting = Promise.resolve(module.start(ctx));
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });
  try {
    const outcome = await Promise.race([starting.then(() => 'started' as const), timedOut]);
    if (outcome === 'timeout') {
      log(`[server] module ${module.name} still starting after ${timeoutMs} ms; continuing without waiting`);
      starting.catch((error: unknown) =>
        log(`[server] module ${module.name} failed to start: ${String(error)}`),
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

function urlOf(info: AddressInfo, host: string): string {
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  return `http://${shown.includes(':') ? `[${shown}]` : shown}:${info.port}`;
}
