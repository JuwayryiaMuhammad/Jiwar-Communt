import { NextResponse, type NextRequest } from 'next/server';
import { backendJson, errorBody, rejectForeignRequest, relayError } from '@jiwar/bff';

export const dynamic = 'force-dynamic';

/**
 * Step 1: a code is emailed whatever the identifier (the backend answers
 * the same for unknown ones, so this cannot be used to probe accounts).
 */
export async function POST(req: NextRequest) {
  const foreign = rejectForeignRequest(req);
  if (foreign) return foreign;
  const input = (await req.json().catch(() => null)) as { identifier?: unknown } | null;
  if (typeof input?.identifier !== 'string') {
    return NextResponse.json(errorBody('VALIDATION_FAILED', 400), { status: 400 });
  }
  try {
    const result = await backendJson('/api/v1/auth/otp/request', { identifier: input.identifier.trim() }, {
      acceptLanguage: req.headers.get('accept-language') ?? 'en',
      userAgent: req.headers.get('user-agent'),
    });
    if (result.status !== 202) return relayError(result.status, result.body);
    return NextResponse.json({ ok: true }, { status: 202, headers: { 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json(errorBody('NETWORK_ERROR', 503), { status: 503 });
  }
}
