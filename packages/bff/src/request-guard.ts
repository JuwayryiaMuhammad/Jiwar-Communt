import type { NextRequest } from 'next/server';
import { errorBody } from './backend';
import { isSameOrigin } from './same-origin';

const BFF_HEADER = 'x-jiwar-bff';

/**
 * CSRF defence for cookie-authenticated BFF routes:
 * - the custom header cannot be set cross-site without a CORS preflight,
 *   which the BFF never answers;
 * - for state-changing methods the Origin, when sent, must be the host
 *   the browser addressed (see same-origin.ts);
 * SameSite=Lax cookies are the third layer.
 */
export function rejectForeignRequest(req: NextRequest): Response | null {
  if (req.headers.get(BFF_HEADER) !== '1') {
    return Response.json(errorBody('FORBIDDEN', 403), { status: 403 });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.get('origin');
    if (origin && !isSameOrigin(origin, req.headers.get('host'))) {
      return Response.json(errorBody('FORBIDDEN', 403), { status: 403 });
    }
  }
  return null;
}
