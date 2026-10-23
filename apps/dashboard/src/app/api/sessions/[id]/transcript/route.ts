import { BackendError } from '../../../../../lib/backend';
import { backendIfLoggedIn } from '../../../../../lib/server/session';

export const dynamic = 'force-dynamic';

/**
 * One finished session's stored transcript, for the Row's View button. Relays the server's
 * /api/sessions/:id/transcript (which needs the Authorization header) to the browser, which
 * authenticates with its session cookie instead.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const backend = await backendIfLoggedIn();
  if (!backend) return Response.json({ error: 'not logged in' }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return Response.json({ error: 'bad session id' }, { status: 400 });
  try {
    const transcript = await backend.sessionTranscript(Number(id));
    return Response.json({ transcript });
  } catch (error) {
    // A session that does not exist is not "unreachable": the browser shows the same note either
    // way, but the status says which it was.
    if (error instanceof BackendError && error.status === 404)
      return Response.json({ error: 'no such session' }, { status: 404 });
    console.error('[dashboard] transcript fetch failed:', error);
    return Response.json({ error: 'cannot reach the server' }, { status: 502 });
  }
}
