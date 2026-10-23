import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ServerContext } from '../context.js';

/**
 * GET /events: Server-Sent Events stream of bus events for the dashboard. The first event is
 * `ready` (subscribed; fetch /api/questions now to get the current state without a gap), then one
 * event per bus event, named by its type (`question.created`, `question.resolved`, `request.created`) with the event
 * as JSON data. A comment line every `keepAliveMs` keeps proxies from closing an idle stream.
 * Auth is the usual Authorization header, so browsers read it with fetch() rather than EventSource.
 */
export function eventRoutes(ctx: ServerContext, keepAliveMs: number): Hono {
  const api = new Hono();
  api.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      let id = 0;
      const off = ctx.bus.onAny(
        (event) =>
          stream
            .writeSSE({ event: event.type, data: JSON.stringify(event), id: String(++id) })
            .catch(() => {}), // the client is gone; onAbort below unsubscribes
      );
      await stream.writeSSE({ event: 'ready', data: '{}', id: String(id) });
      await new Promise<void>((resolve) => {
        const keepAlive = setInterval(() => void stream.write(': keepalive\n\n'), keepAliveMs);
        const done = () => {
          clearInterval(keepAlive);
          ctx.shutdown.removeEventListener('abort', done);
          off();
          resolve();
        };
        if (ctx.shutdown.aborted || stream.aborted) return done();
        stream.onAbort(done);
        ctx.shutdown.addEventListener('abort', done, { once: true });
      });
    }),
  );
  return api;
}
