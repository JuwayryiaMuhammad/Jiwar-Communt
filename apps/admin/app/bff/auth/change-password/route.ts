import { NextResponse, type NextRequest } from 'next/server';
import {
  backendJson,
  clearSession,
  errorBody,
  readTokens,
  refreshOnce,
  rejectForeignRequest,
  type SessionTokens,
  relayError,
  writeSession,
} from '@jiwar/bff';
import { adminBff, fullTokens, PASSWORD_CHANGE_COOKIE } from '@/lib/bff';
import { SESSION_PREFIX } from '@/lib/session-prefix';

export const dynamic = 'force-dynamic';

/**
 * Forced change (restricted token from login) or a voluntary one from the
 * account page (full access token). The backend revokes every platform
 * session and returns a fresh one, which replaces the cookies here.
 */
export async function POST(req: NextRequest) {
  const foreign = rejectForeignRequest(req);
  if (foreign) return foreign;

  const input = (await req.json().catch(() => null)) as {
    currentPassword?: unknown;
    newPassword?: unknown;
  } | null;
  if (typeof input?.currentPassword !== 'string' || typeof input.newPassword !== 'string') {
    return NextResponse.json(errorBody('VALIDATION_FAILED', 400), { status: 400 });
  }

  const userAgent = req.headers.get('user-agent');
  const restricted = req.cookies.get(PASSWORD_CHANGE_COOKIE)?.value;
  const session = readTokens(req, SESSION_PREFIX);
  let accessToken = restricted ?? session.accessToken;
  // A full session whose access cookie lapsed: renew it first (same single
  // flight as the proxy), and keep the renewed cookies even if the change
  // itself fails.
  let renewed: SessionTokens | undefined;
  if (!accessToken && session.refreshToken) {
    const r = await refreshOnce(session.refreshToken, (token) => adminBff.refresh(token, userAgent));
    if (r.ok) {
      renewed = r.tokens;
      accessToken = r.tokens.accessToken;
    } else if (!r.ended) {
      return NextResponse.json(errorBody('NETWORK_ERROR', 503), { status: 503 });
    }
  }
  if (!accessToken) {
    const res = NextResponse.json(errorBody('UNAUTHENTICATED', 401), { status: 401 });
    clearSession(res, SESSION_PREFIX);
    return res;
  }

  let result;
  try {
    result = await backendJson<Record<string, unknown>>(
      '/api/v1/platform/auth/change-password',
      { currentPassword: input.currentPassword, newPassword: input.newPassword },
      { accessToken, userAgent },
    );
  } catch {
    return NextResponse.json(errorBody('NETWORK_ERROR', 503), { status: 503 });
  }

  if (result.status !== 200) {
    // A wrong current password is INVALID_CREDENTIALS (401): a form error,
    // not the end of the session.
    const code = (result.body as { code?: string } | undefined)?.code;
    if (result.status === 401 && code !== 'INVALID_CREDENTIALS') {
      const res = relayError(401, result.body);
      const next = new NextResponse(res.body, res);
      clearSession(next, SESSION_PREFIX);
      next.cookies.set(PASSWORD_CHANGE_COOKIE, '', { path: '/bff/auth', maxAge: 0 });
      return next;
    }
    const failed = relayError(result.status === 401 ? 400 : result.status, result.body);
    const res = new NextResponse(failed.body, failed);
    if (renewed) writeSession(res, SESSION_PREFIX, renewed);
    return res;
  }

  const tokens = fullTokens(result.body);
  if (!tokens) return NextResponse.json(errorBody('INTERNAL_ERROR', 502), { status: 502 });
  const res = NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  writeSession(res, SESSION_PREFIX, tokens);
  res.cookies.set(PASSWORD_CHANGE_COOKIE, '', { path: '/bff/auth', maxAge: 0 });
  return res;
}
