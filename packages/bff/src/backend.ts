/**
 * The backend is reached only from the BFF (server side). JIWAR_API_URL is
 * the origin without the `/api/v1` prefix, e.g. http://localhost:3100.
 */
export function backendOrigin(): string {
  const url = process.env.JIWAR_API_URL;
  if (!url) throw new Error('JIWAR_API_URL is not set');
  return url.replace(/\/+$/, '');
}

const TIMEOUT_MS = 15_000;

/**
 * `userAgent` is the browser's: the API names a session by it and compares
 * it at sign-in to raise the new-device alert (ADR 0036). Without it every
 * call would carry this server's own agent.
 */
export async function backendFetch(
  path: string,
  init: RequestInit & { accessToken?: string; acceptLanguage?: string; userAgent?: string | null } = {},
): Promise<Response> {
  const { accessToken, acceptLanguage, userAgent, headers, ...rest } = init;
  const h = new Headers(headers);
  h.set('accept', 'application/json');
  if (accessToken) h.set('authorization', `Bearer ${accessToken}`);
  if (acceptLanguage) h.set('accept-language', acceptLanguage);
  if (userAgent) h.set('user-agent', userAgent);
  return fetch(`${backendOrigin()}${path}`, {
    ...rest,
    headers: h,
    cache: 'no-store',
    redirect: 'manual',
    signal: rest.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** POST a JSON body; returns status and the parsed body (or undefined). */
export async function backendJson<T = unknown>(
  path: string,
  body: unknown,
  init: { accessToken?: string; acceptLanguage?: string; userAgent?: string | null; method?: string } = {},
): Promise<{ status: number; body: T | undefined }> {
  const res = await backendFetch(path, {
    method: init.method ?? 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    accessToken: init.accessToken,
    acceptLanguage: init.acceptLanguage,
    userAgent: init.userAgent,
  });
  const text = await res.text();
  let parsed: T | undefined;
  try {
    parsed = text ? (JSON.parse(text) as T) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed };
}

/** The backend's error envelope, trimmed to what a browser may see. */
export function errorBody(code: string, status: number, extra?: { fields?: unknown; params?: unknown; requestId?: unknown }) {
  return {
    statusCode: status,
    code,
    ...(extra?.fields ? { fields: extra.fields } : {}),
    ...(extra?.params ? { params: extra.params } : {}),
    ...(extra?.requestId ? { requestId: extra.requestId } : {}),
  };
}

/**
 * Pass a backend error through without its developer `message` or `path`:
 * the browser gets code, fields, params and the request id for support.
 */
export function relayError(status: number, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const code = typeof b.code === 'string' ? b.code : status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
  return Response.json(
    errorBody(code, status, { fields: b.fields, params: b.params, requestId: b.requestId }),
    { status, headers: { 'cache-control': 'no-store' } },
  );
}
