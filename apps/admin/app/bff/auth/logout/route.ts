import { NextResponse, type NextRequest } from 'next/server';
import { backendJson, clearSession, readTokens, rejectForeignRequest } from '@jiwar/bff';
import { PASSWORD_CHANGE_COOKIE, WHO_COOKIE } from '@/lib/bff';
import { SESSION_PREFIX } from '@/lib/session-prefix';

export const dynamic = 'force-dynamic';

/** Revokes the backend session (best effort) and always clears the cookies. */
export async function POST(req: NextRequest) {
  const foreign = rejectForeignRequest(req);
  if (foreign) return foreign;
  const { refreshToken } = readTokens(req, SESSION_PREFIX);
  if (refreshToken) {
    await backendJson('/api/v1/platform/auth/logout', { refreshToken }).catch(() => undefined);
  }
  const res = new NextResponse(null, { status: 204 });
  clearSession(res, SESSION_PREFIX);
  res.cookies.set(PASSWORD_CHANGE_COOKIE, '', { path: '/bff/auth', maxAge: 0 });
  res.cookies.set(WHO_COOKIE, '', { path: '/bff', maxAge: 0 });
  return res;
}
