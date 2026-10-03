import { NextResponse, type NextRequest } from 'next/server';
import { backendJson, errorBody, rejectForeignRequest, relayError } from '@jiwar/bff';
import { TICKET_COOKIE } from '@/lib/bff';

export const dynamic = 'force-dynamic';

interface Verified {
  loginTicket: string;
  accounts: { accountId: string; tenantName: string; accountType: string }[];
}

/**
 * Step 2: the code buys a short-lived login ticket and the list of the
 * person's accounts (one per compound and capacity). The ticket stays in
 * an httpOnly cookie; the browser only sees the accounts.
 */
export async function POST(req: NextRequest) {
  const foreign = rejectForeignRequest(req);
  if (foreign) return foreign;
  const input = (await req.json().catch(() => null)) as { identifier?: unknown; code?: unknown } | null;
  if (typeof input?.identifier !== 'string' || typeof input.code !== 'string') {
    return NextResponse.json(errorBody('VALIDATION_FAILED', 400), { status: 400 });
  }
  let result;
  try {
    result = await backendJson<Verified>('/api/v1/auth/otp/verify', {
      identifier: input.identifier.trim(),
      code: input.code.trim(),
    });
  } catch {
    return NextResponse.json(errorBody('NETWORK_ERROR', 503), { status: 503 });
  }
  if (result.status !== 200 || !result.body) return relayError(result.status, result.body);

  const res = NextResponse.json(
    { accounts: result.body.accounts },
    { headers: { 'cache-control': 'no-store' } },
  );
  res.cookies.set(TICKET_COOKIE, result.body.loginTicket, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/bff/auth',
    maxAge: 300,
  });
  return res;
}
