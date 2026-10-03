import type { NextRequest, NextResponse } from 'next/server';

/**
 * Tokens live in httpOnly cookies; the browser never reads them.
 *
 * - `<p>_at`: access token, path `/bff`, expires a little before the JWT so
 *   the BFF refreshes instead of sending a token about to lapse.
 * - `<p>_rt`: refresh token, path `/bff`, expires with the session.
 * - `<p>_s`: a marker with no secret, path `/`, so the page proxy can send a
 *   visitor without a session to the sign-in page. The backend remains the
 *   only judge of a session.
 */
export interface SessionTokens {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

const ACCESS_SKEW_SECONDS = 20;

export function cookieNames(prefix: string) {
  return {
    access: `${prefix}_at`,
    refresh: `${prefix}_rt`,
    marker: `${prefix}_s`,
  };
}

const secure = () => process.env.NODE_ENV === 'production';

export function readTokens(req: NextRequest, prefix: string) {
  const n = cookieNames(prefix);
  return {
    accessToken: req.cookies.get(n.access)?.value,
    refreshToken: req.cookies.get(n.refresh)?.value,
  };
}

export function writeSession(res: NextResponse, prefix: string, tokens: SessionTokens) {
  const n = cookieNames(prefix);
  const expires = new Date(tokens.refreshTokenExpiresAt);
  res.cookies.set(n.access, tokens.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secure(),
    path: '/bff',
    maxAge: Math.max(1, Math.floor(tokens.accessTokenExpiresIn) - ACCESS_SKEW_SECONDS),
  });
  res.cookies.set(n.refresh, tokens.refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secure(),
    path: '/bff',
    expires,
  });
  res.cookies.set(n.marker, '1', {
    httpOnly: true,
    sameSite: 'lax',
    secure: secure(),
    path: '/',
    expires,
  });
}

export function clearSession(res: NextResponse, prefix: string) {
  const n = cookieNames(prefix);
  res.cookies.set(n.access, '', { path: '/bff', maxAge: 0 });
  res.cookies.set(n.refresh, '', { path: '/bff', maxAge: 0 });
  res.cookies.set(n.marker, '', { path: '/', maxAge: 0 });
}
