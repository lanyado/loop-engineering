import type {
  DeadlineSweeper,
  QuestionBus,
  QuestionService,
  RequestService,
  Timers,
} from '@loop-engineering/ask-human';
import type { McpConnection } from '@loop-engineering/ask-human';
import type { Clock, Store } from '@loop-engineering/core';
import type { SessionRunner } from '@loop-engineering/runner';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import type { ServerConfig } from './config.js';

/** What the server hands every route and module. */
export interface ServerContext {
  config: ServerConfig;
  store: Store;
  clock: Clock;
  timers: Timers;
  bus: QuestionBus;
  questions: QuestionService;
  /** Records a task the human sent and emits request.created; use it instead of store.requests.create. */
  requests: RequestService;
  /**
   * The server's one SessionRunner (null when WORKTREES_ROOT is not set). The PR loop and the router
   * both drive sessions through it, so its per-session lock serializes them.
   */
  runner: SessionRunner | null;
  sweeper: DeadlineSweeper;
  /** Aborts when the server shuts down; long-lived handlers (SSE) end on it. */
  shutdown: AbortSignal;
}

/** A self-contained feature plugged into the server: its API routes, MCP tools and start/stop hooks. */
export interface ServerModule {
  name: string;
  /** Routes under /api. DASHBOARD_TOKEN auth and CORS are already applied. */
  api?(api: Hono, ctx: ServerContext): void;
  /**
   * Tools added to the /mcp server next to ask_human (MCP_TOKEN auth already applied). Called for
   * every MCP connection; `connection.sessionHeader` is the caller's X-Loop-Session-Id.
   */
  mcp?(server: McpServer, connection: McpConnection, ctx: ServerContext): void;
  /** Routes at the root, with no auth applied: the module must authenticate requests itself. */
  routes?(app: Hono, ctx: ServerContext): void;
  /**
   * Called after the HTTP server is listening, in module order, before the deadline sweeper starts.
   * The server waits at most moduleStartTimeoutMs (10 s) for each, so do not wait on the network here.
   */
  start?(ctx: ServerContext): void | Promise<void>;
  /** Called on shutdown, in reverse module order, before the store closes. */
  stop?(): void | Promise<void>;
}
