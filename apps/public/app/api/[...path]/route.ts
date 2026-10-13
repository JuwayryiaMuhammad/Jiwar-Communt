import type { NextRequest } from 'next/server';
import { backendFetch, errorBody, rejectForeignRequest, relayError } from '@jiwar/bff';
import { MAX_BODY_BYTES, backendPath, forwardedHeaders, isJson } from '@/lib/proxy-rules';

export const dynamic = 'force-dynamic';

const HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
};

const refuse = (code: string, status: number) => Response.json(errorBody(code, status), { status, headers: HEADERS });

/** The body as text, or null once it passes the cap. */
async function readCapped(req: NextRequest): Promise<string | null> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return null;
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The only way from a browser to the API: a fixed set of public POST routes
 * (lib/proxy-rules.ts). A link's token travels in the JSON body, which is
 * passed on and never logged; there is no session, cookie or credential.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (rejectForeignRequest(req)) return refuse('FORBIDDEN', 403);

  const path = backendPath((await ctx.params).path);
  if (!path) return refuse('NOT_FOUND', 404);
  if (!isJson(req.headers.get('content-type'))) return refuse('VALIDATION_FAILED', 400);

  const text = await readCapped(req);
  if (text === null) return refuse('PAYLOAD_TOO_LARGE', 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse('VALIDATION_FAILED', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('VALIDATION_FAILED', 400);

  let upstream: Response;
  try {
    upstream = await backendFetch(path, {
      method: 'POST',
      headers: forwardedHeaders((name) => req.headers.get(name)),
      body: JSON.stringify(body),
    });
  } catch {
    return refuse('UPSTREAM_UNAVAILABLE', 502);
  }

  // The API answers these routes itself; a redirect is not its answer.
  if (upstream.status >= 300 && upstream.status < 400) return refuse('UPSTREAM_UNAVAILABLE', 502);

  const requestId = upstream.headers.get('x-request-id');
  const headers = { ...HEADERS, ...(requestId ? { 'x-request-id': requestId } : {}) };
  const answer = await upstream.text();
  let parsed: unknown;
  try {
    parsed = answer ? JSON.parse(answer) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!upstream.ok) {
    const relayed = relayError(upstream.status, parsed);
    for (const [name, value] of Object.entries(headers)) relayed.headers.set(name, value);
    return relayed;
  }
  if (parsed === undefined) return new Response(null, { status: upstream.status, headers });
  return Response.json(parsed, { status: upstream.status, headers });
}
