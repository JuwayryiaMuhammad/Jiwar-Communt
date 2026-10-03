import type { NextRequest } from 'next/server';
import { errorBody } from './backend';

const BFF_HEADER = 'x-jiwar-bff';

/**
 * CSRF defence for cookie-authenticated BFF routes:
 * - the custom header cannot be set cross-site without a CORS preflight,
 *   which the BFF never answers;
 * - for state-changing methods the Origin, when sent, must be this host.
 * SameSite=Lax cookies are the third layer.
 */
export function rejectForeignRequest(req: NextRequest): Response | null {
  if (req.headers.get(BFF_HEADER) !== '1') {
    return Response.json(errorBody('FORBIDDEN', 403), { status: 403 });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.get('origin');
    if (origin && origin !== req.nextUrl.origin) {
      return Response.json(errorBody('FORBIDDEN', 403), { status: 403 });
    }
  }
  return null;
}
