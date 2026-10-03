import { NextResponse, type NextRequest } from 'next/server';
import { rejectForeignRequest } from '@jiwar/bff';
import { TENANT_COOKIE } from '@/lib/bff';

export const dynamic = 'force-dynamic';

/** Display-only context; who the manager is comes from GET /api/v1/me. */
export async function GET(req: NextRequest) {
  const foreign = rejectForeignRequest(req);
  if (foreign) return foreign;
  return NextResponse.json(
    { tenantName: req.cookies.get(TENANT_COOKIE)?.value ?? null },
    { headers: { 'cache-control': 'no-store' } },
  );
}
