import { backendIfLoggedIn } from '../../../lib/server/session';

export const dynamic = 'force-dynamic';
// Vercel ends a function after this long; the browser's EventSource reconnects on its own.
export const maxDuration = 300;

/**
 * Relays the server's SSE stream (which needs the Authorization header) to the browser, which
 * authenticates with its session cookie instead. The bytes pass through unchanged; when the
 * viewer disconnects, request.signal aborts the upstream fetch.
 */
export async function GET(request: Request) {
  const backend = await backendIfLoggedIn();
  if (!backend) return Response.json({ error: 'not logged in' }, { status: 401 });
  let upstream: Response;
  try {
    upstream = await backend.events(request.signal);
  } catch (error) {
    console.error('[dashboard] event stream failed:', error);
    return Response.json({ error: 'cannot reach the server' }, { status: 502 });
  }
  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
