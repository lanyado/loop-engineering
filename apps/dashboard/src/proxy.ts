import { NextResponse, type NextRequest } from 'next/server';
import { accessConfig, checkLocalHeaders, listeningPort } from './lib/access';
import { authConfig, SESSION_COOKIE, verifySessionToken } from './lib/auth';

/**
 * DASHBOARD_AUTH=none: answers only requests for this machine (Host) and same-origin writes
 * (Origin), and sends /login to /. password: sends logged-out viewers to /login (401 for /api/*).
 * Pages, actions and routes check again themselves (lib/server/session).
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const access = accessConfig(process.env);
  if (access.problem) return new NextResponse(access.problem, { status: 500 });

  if (access.mode === 'none') {
    const verdict = checkLocalHeaders(request.method, request.headers, listeningPort(process.env));
    if (!verdict.ok) return new NextResponse(`Forbidden: ${verdict.reason}.`, { status: 403 });
    if (pathname === '/login') return NextResponse.redirect(new URL('/', request.url));
    return NextResponse.next();
  }

  if (pathname === '/login') return NextResponse.next();
  const { secret } = authConfig(process.env);
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (secret && (await verifySessionToken(secret, token, Date.now()))) return NextResponse.next();
  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'not logged in' }, { status: 401 });
  const login = new URL('/login', request.url);
  if (pathname !== '/') login.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next's own assets and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
