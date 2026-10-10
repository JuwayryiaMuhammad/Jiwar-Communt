import { NextResponse, type NextRequest } from 'next/server';
import { backendFetch, backendJson, errorBody, rejectForeignRequest, relayError, writeSession } from '@jiwar/bff';
import { mayEnter } from '@/lib/access';
import { sessionTokens, TENANT_COOKIE, TICKET_COOKIE } from '@/lib/bff';
import { SESSION_PREFIX } from '@/lib/session-prefix';

export const dynamic = 'force-dynamic';

/**
 * Step 3: exchange the ticket for a session of the chosen account. This
 * dashboard is for managers and for roles holding a maintenance permission
 * (lib/access.ts), read from the account's own `/me`. A session of anyone
 * else is logged out at once and never reaches a cookie.
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
    // The browser's agent, not this server's: the API knows a device by it
    // and alerts the account on a sign-in from a new one (ADR 0036).
    result = await backendJson<Record<string, unknown>>(
      '/api/v1/auth/select-account',
      { loginTicket: ticket, accountId: input.accountId },
      { userAgent: req.headers.get('user-agent') },
    );
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

  const tokens = sessionTokens(result.body);
  const admitted = tokens !== null && (await admits(tokens.accessToken, req.headers.get('user-agent')));
  if (!tokens || admitted !== true) {
    if (typeof result.body.refreshToken === 'string') {
      await backendJson('/api/v1/auth/logout', { refreshToken: result.body.refreshToken }).catch(() => undefined);
    }
    // The API could not be asked: nobody is let in on a guess.
    const res =
      admitted === null
        ? NextResponse.json(errorBody('NETWORK_ERROR', 503), { status: 503 })
        : NextResponse.json(errorBody('NO_DASHBOARD_ACCESS', 403), { status: 403 });
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

/** The new session's own `/me`: true or false, or null when it cannot be read. */
async function admits(accessToken: string, userAgent: string | null): Promise<boolean | null> {
  try {
    const res = await backendFetch('/api/v1/me', { accessToken, userAgent });
    if (!res.ok) return res.status === 401 || res.status === 403 ? false : null;
    return mayEnter((await res.json()) as Record<string, unknown>);
  } catch {
    return null;
  }
}
