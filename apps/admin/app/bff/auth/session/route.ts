import { NextResponse, type NextRequest } from 'next/server';
import { readTokens, rejectForeignRequest } from '@jiwar/bff';
import { PASSWORD_CHANGE_COOKIE, WHO_COOKIE } from '@/lib/bff';
import { SESSION_PREFIX } from '@/lib/session-prefix';

export const dynamic = 'force-dynamic';

/** What the shell shows; validity is checked by the backend on each call. */
export async function GET(req: NextRequest) {
  const foreign = rejectForeignRequest(req);
  if (foreign) return foreign;
  const { refreshToken } = readTokens(req, SESSION_PREFIX);
  return NextResponse.json(
    {
      email: req.cookies.get(WHO_COOKIE)?.value ?? null,
      signedIn: Boolean(refreshToken),
      passwordChangeRequired: req.cookies.has(PASSWORD_CHANGE_COOKIE),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
