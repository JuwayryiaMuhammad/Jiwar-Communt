import { NextResponse, type NextRequest } from 'next/server';
import { connectSrc } from './lib/csp';

/**
 * Page headers. The pages hold a link's secret in memory, so nothing may be
 * cached, framed, referred or indexed, and no script runs that this app did
 * not serve: Next's own inline bootstrap carries the per-request nonce, and
 * there is no third-party origin at all.
 */
export function proxy(req: NextRequest) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
  const dev = process.env.NODE_ENV !== 'production';
  const csp = [
    "default-src 'none'",
    // Development only: React's error overlay evaluates, and styles are injected.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
    "img-src 'self' data:",
    "font-src 'self'",
    connectSrc(req.nextUrl.pathname, process.env.UPLOAD_ORIGIN, dev),
    "manifest-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  // Next reads the nonce from the request's policy and puts it on its scripts.
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);

  const res = NextResponse.next({ request: { headers } });
  res.headers.set('Content-Security-Policy', csp);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export const config = {
  // /api sets its own headers (lib/proxy route); hashed static files are public.
  matcher: ['/((?!api/|_next/static|_next/image|icon.svg).*)'],
};
