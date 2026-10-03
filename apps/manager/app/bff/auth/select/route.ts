import { NextResponse, type NextRequest } from 'next/server';
import { backendJson, errorBody, rejectForeignRequest, relayError, writeSession } from '@jiwar/bff';
import { managerTokens, TENANT_COOKIE, TICKET_COOKIE } from '@/lib/bff';
import { SESSION_PREFIX } from '@/lib/session-prefix';

export const dynamic = 'force-dynamic';

/**
 * Step 3: exchange the ticket for a session of the chosen account. This
 * dashboard is for manager accounts only: a session of any other kind is
 * logged out at once and never reaches a cookie.
 */
export async function POST(req: NextRequest) {
  const foreign = rejectForeignRequest(req);
  if (foreign) return foreign;
  const input = (await req.json().catch(() => null)) as { accountId?: unknown; tenantName?: unknown } | null;
  const ticket = req.cookies.get(TICKET_COOKIE)?.value;
  if (typeof input?.accountId !== 'string') {
    return NextResponse.json(errorBody('VALIDATION_FAILED', 400), { status: 400 });
  }
  if (!ticket) return NextResponse.json(errorBody('LOGIN_TICKET_INVALID', 401), { status: 401 });

  let result;
  try {
    result = await backendJson<Record<string, unknown>>('/api/v1/auth/select-account', {
      loginTicket: ticket,
      accountId: input.accountId,
    });
  } catch {
    return NextResponse.json(errorBody('NETWORK_ERROR', 503), { status: 503 });
  }

  // The ticket is single use whatever happened.
  const clearTicket = (res: NextResponse) => res.cookies.set(TICKET_COOKIE, '', { path: '/bff/auth', maxAge: 0 });

  if (result.status !== 200 || !result.body) {
    const failed = relayError(result.status, result.body);
    const res = new NextResponse(failed.body, failed);
    clearTicket(res);
    return res;
  }

  const tokens = managerTokens(result.body);
  if (!tokens) {
    if (typeof result.body.refreshToken === 'string') {
      await backendJson('/api/v1/auth/logout', { refreshToken: result.body.refreshToken }).catch(() => undefined);
    }
    const res = NextResponse.json(errorBody('NOT_A_MANAGER', 403), { status: 403 });
    clearTicket(res);
    return res;
  }

  const res = NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  writeSession(res, SESSION_PREFIX, tokens);
  clearTicket(res);
  if (typeof input.tenantName === 'string') {
    res.cookies.set(TENANT_COOKIE, input.tenantName.slice(0, 200), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/bff',
      expires: new Date(tokens.refreshTokenExpiresAt),
    });
  }
  return res;
}
