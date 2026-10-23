import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { SESSION_HEADER } from '@loop-engineering/ask-human';
import { NotFoundError, safeEqual, ValidationError, verifySessionToken } from '@loop-engineering/core';
import { Hono, type MiddlewareHandler } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { ServerContext, ServerModule } from './context.js';
import { eventRoutes } from './routes/events.js';
import { questionRoutes } from './routes/questions.js';

export interface AppOptions {
  mcp: McpHttpHandler;
  modules: readonly ServerModule[];
  sseKeepAliveMs: number;
}

/**
 * Routes:
 *   GET  /health                       no auth
 *   ALL  /mcp                          the session's token for its X-Loop-Session-Id (see mcpAuth);
 *                                      ask_human + module tools (Streamable HTTP)
 *   GET  /api/questions[?status=&sessionId=], GET /api/questions/:id,
 *   POST /api/questions/:id/answer,  GET /api/events (SSE)              DASHBOARD_TOKEN
 *   + whatever modules add under /api (DASHBOARD_TOKEN) or at the root (their own auth)
 */
export function createApp(ctx: ServerContext, options: AppOptions): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse(); // e.g. 401 from bearerAuth
    if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
    if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
    console.error('[server] unhandled error:', error);
    return c.json({ error: 'internal error' }, 500);
  });
  app.notFound((c) => c.json({ error: 'not found' }, 404));

  app.get('/health', (c) => c.json({ ok: true }));

  app.all('/mcp', mcpAuth(ctx), (c) => options.mcp.fetch(c.req.raw));

  const api = new Hono();
  if (ctx.config.corsOrigins.length > 0) {
    api.use('*', cors({ origin: ctx.config.corsOrigins, allowHeaders: ['Authorization', 'Content-Type'] }));
  }
  api.use('*', bearerAuth({ token: ctx.config.dashboardToken }));
  api.use('*', bodyLimit({ maxSize: 64 * 1024 }));
  api.route('/', questionRoutes(ctx));
  api.route('/', eventRoutes(ctx, options.sseKeepAliveMs));
  for (const module of options.modules) module.api?.(api, ctx);
  app.route('/api', api);

  for (const module of options.modules) module.routes?.(app, ctx);
  return app;
}

/**
 * /mcp accepts a request only when its bearer is the session token (HMAC of MCP_TOKEN) of the session
 * named in X-Loop-Session-Id, and that session exists and has not ended, so the header cannot be forged with a token from another session. The raw
 * MCP_TOKEN works only with MCP_ALLOW_SHARED_TOKEN=on (manual testing).
 */
function mcpAuth(ctx: ServerContext): MiddlewareHandler {
  const { mcpToken, allowSharedMcpToken } = ctx.config;
  return async (c, next) => {
    const auth = c.req.header('Authorization') ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? '';
    const header = c.req.header(SESSION_HEADER)?.trim() ?? '';
    const sessionId = /^[1-9]\d{0,15}$/.test(header) ? Number(header) : null;
    // A valid token for a session that no longer exists or has ended is refused too.
    const live = (id: number) => {
      const s = ctx.store.sessions.get(id);
      return s !== undefined && s.status !== 'ended';
    };
    const ok =
      token !== '' &&
      ((sessionId !== null && verifySessionToken(mcpToken, sessionId, token) && live(sessionId)) ||
        (allowSharedMcpToken === true && safeEqual(token, mcpToken)));
    if (!ok) {
      c.header('WWW-Authenticate', 'Bearer realm="mcp"');
      return c.json({ error: 'unauthorized: send the session token for your X-Loop-Session-Id' }, 401);
    }
    await next();
  };
}
