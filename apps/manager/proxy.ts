import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_PREFIX } from './lib/session-prefix';

/**
 * Page gate only: a visitor without the session marker goes to sign-in.
 * Whether the session is still valid is the backend's call, on every BFF
 * request; a stale marker just ends in a 401 and the same redirect.
 */
export function proxy(req: NextRequest) {
  const hasSession = req.cookies.has(`${SESSION_PREFIX}_s`);
  const { pathname } = req.nextUrl;
  const isAuthPage = pathname === '/login';
  if (!hasSession && !isAuthPage) {
    const url = new URL('/login', req.url);
    if (pathname !== '/') url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  if (hasSession && pathname === '/login') {
    return NextResponse.redirect(new URL('/', req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!bff|_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
