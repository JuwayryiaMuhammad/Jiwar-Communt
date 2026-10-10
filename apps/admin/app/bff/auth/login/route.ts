import { NextResponse, type NextRequest } from 'next/server';
import { backendJson, errorBody, rejectForeignRequest, relayError, writeSession } from '@jiwar/bff';
import { fullTokens, PASSWORD_CHANGE_COOKIE, WHO_COOKIE } from '@/lib/bff';
import { SESSION_PREFIX } from '@/lib/session-prefix';

export const dynamic = 'force-dynamic';

const secure = process.env.NODE_ENV === 'production';

export async function POST(req: NextRequest) {
  const foreign = rejectForeignRequest(req);
  if (foreign) return foreign;

  const input = (await req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  if (typeof input?.email !== 'string' || typeof input.password !== 'string') {
    return NextResponse.json(errorBody('VALIDATION_FAILED', 400), { status: 400 });
  }
  const email = input.email.trim();

  let result;
  try {
    result = await backendJson<Record<string, unknown>>(
      '/api/v1/platform/auth/login',
      { email, password: input.password },
      { userAgent: req.headers.get('user-agent') },
    );
  } catch {
    return NextResponse.json(errorBody('NETWORK_ERROR', 503), { status: 503 });
  }
  if (result.status !== 200 || !result.body) return relayError(result.status, result.body);

  const body = result.body;
  const res = NextResponse.json({ scope: body.scope }, { headers: { 'cache-control': 'no-store' } });
  res.cookies.set(WHO_COOKIE, email, { httpOnly: true, sameSite: 'lax', secure, path: '/bff' });

  if (body.scope === 'password_change' && typeof body.accessToken === 'string') {
    res.cookies.set(PASSWORD_CHANGE_COOKIE, body.accessToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      path: '/bff/auth',
      maxAge: typeof body.accessTokenExpiresIn === 'number' ? body.accessTokenExpiresIn : 600,
    });
    return res;
  }
  const tokens = fullTokens(body);
  if (!tokens) return NextResponse.json(errorBody('INTERNAL_ERROR', 502), { status: 502 });
  writeSession(res, SESSION_PREFIX, tokens);
  return res;
}
