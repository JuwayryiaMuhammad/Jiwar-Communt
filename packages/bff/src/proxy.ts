import { NextResponse, type NextRequest } from 'next/server';
import { backendFetch, errorBody } from './backend';
import { rejectForeignRequest } from './request-guard';
import {
  clearSession,
  readTokens,
  writeSession,
  type SessionTokens,
} from './session';
import { SingleFlight } from './single-flight';

export type RefreshResult =
  | { ok: true; tokens: SessionTokens }
  /** The backend refused the token: the session is over. */
  | { ok: false; ended: true }
  /** Backend unreachable or failing: keep the cookies, try again later. */
  | { ok: false; ended: false };

export interface BffProxyConfig {
  cookiePrefix: string;
  /** `path` starts with `/api/v1/`; anything else is already refused. */
  isAllowed(path: string, method: string): boolean;
  /** Calls the app's refresh endpoint on the backend, as the browser's agent. */
  refresh(refreshToken: string, userAgent?: string | null): Promise<RefreshResult>;
}

const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'accept-language',
  'idempotency-key',
  'user-agent',
];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'x-request-id'];

/**
 * One per server process. Every route bundle (the proxy, the auth routes)
 * and every dev-server reload must share it, or two copies could refresh
 * the same token at once; hence globalThis rather than module state.
 */
const KEY = Symbol.for('jiwar.bff.refresh-single-flight');
const store = globalThis as unknown as Record<symbol, SingleFlight<RefreshResult> | undefined>;
const singleFlight = (store[KEY] ??= new SingleFlight<RefreshResult>());

export function refreshOnce(
  refreshToken: string,
  refresh: (token: string) => Promise<RefreshResult>,
): Promise<RefreshResult> {
  return singleFlight.run(refreshToken, () => refresh(refreshToken));
}

function unauthenticated(prefix: string) {
  const res = NextResponse.json(errorBody('UNAUTHENTICATED', 401), {
    status: 401,
    headers: { 'cache-control': 'no-store' },
  });
  clearSession(res, prefix);
  return res;
}

function unavailable() {
  return NextResponse.json(errorBody('NETWORK_ERROR', 503), {
    status: 503,
    headers: { 'cache-control': 'no-store' },
  });
}

/** `/bff/api/v1/units` → `/api/v1/units`, or null for anything suspicious. */
export function backendPath(segments: string[]): string | null {
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('/') || s.includes('\\'))) {
    return null;
  }
  const path = '/' + segments.map(encodeURIComponent).join('/');
  return path.startsWith('/api/v1/') ? path : null;
}

/**
 * Route handlers for `app/bff/[...path]/route.ts`. The browser calls
 * `/bff/api/v1/...`; the BFF adds the bearer token from the cookie and
 * relays the response. An expired access token is refreshed once (single
 * flight, see SingleFlight) and the request retried once: a 401 is decided
 * by the auth guard before any handler runs, so the retry cannot repeat a
 * side effect.
 */
export function createBffProxy(config: BffProxyConfig) {
  async function handle(
    req: NextRequest,
    ctx: { params: Promise<{ path: string[] }> },
  ): Promise<Response> {
    const foreign = rejectForeignRequest(req);
    if (foreign) return foreign;

    const { path: segments } = await ctx.params;
    const path = backendPath(segments);
    if (!path || !config.isAllowed(path, req.method)) {
      return NextResponse.json(errorBody('NOT_FOUND', 404), { status: 404 });
    }

    let { accessToken, refreshToken } = readTokens(req, config.cookiePrefix);
    let renewed: SessionTokens | undefined;

    const renew = async (): Promise<Response | null> => {
      if (!refreshToken) return unauthenticated(config.cookiePrefix);
      const result = await refreshOnce(refreshToken, (token) =>
        config.refresh(token, req.headers.get('user-agent')),
      );
      if (!result.ok) {
        return result.ended ? unauthenticated(config.cookiePrefix) : unavailable();
      }
      renewed = result.tokens;
      accessToken = result.tokens.accessToken;
      refreshToken = result.tokens.refreshToken;
      return null;
    };

    if (!accessToken) {
      const failed = await renew();
      if (failed) return failed;
    }

    const body =
      req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers.get(name);
      if (value) headers.set(name, value);
    }
    const target = path + req.nextUrl.search;

    const send = () =>
      backendFetch(target, { method: req.method, headers, body, accessToken });

    let upstream: Response;
    try {
      upstream = await send();
      if (upstream.status === 401 && !renewed) {
        const failed = await renew();
        if (failed) return failed;
        upstream = await send();
      }
    } catch {
      return unavailable();
    }

    if (upstream.status === 401) return unauthenticated(config.cookiePrefix);

    const resHeaders = new Headers({ 'cache-control': 'no-store' });
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) resHeaders.set(name, value);
    }
    let payload: BodyInit | null = null;
    if (upstream.status !== 204 && upstream.status !== 304) {
      const text = await upstream.text();
      payload = upstream.ok ? text : sanitizeError(text, upstream.status);
      if (!upstream.ok) resHeaders.set('content-type', 'application/json');
    }
    const res = new NextResponse(payload, { status: upstream.status, headers: resHeaders });
    if (renewed) writeSession(res, config.cookiePrefix, renewed);
    return res;
  }

  return { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle };
}

/** Drops the developer `message` and `path` from a backend error. */
function sanitizeError(text: string, status: number): string {
  try {
    const b = JSON.parse(text) as Record<string, unknown>;
    return JSON.stringify(
      errorBody(typeof b.code === 'string' ? b.code : 'REQUEST_FAILED', status, {
        fields: b.fields,
        params: b.params,
        requestId: b.requestId,
      }),
    );
  } catch {
    return JSON.stringify(errorBody(status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED', status));
  }
}

/**
 * Shared shape of the two backends' refresh responses. Anything but 200 or
 * 401 (e.g. 5xx, network) keeps the session: a blip must not sign users out.
 */
export async function callRefresh(
  path: string,
  refreshToken: string,
  pick: (body: Record<string, unknown>) => SessionTokens | null,
  userAgent?: string | null,
): Promise<RefreshResult> {
  try {
    const res = await backendFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      userAgent,
    });
    if (res.status === 401 || res.status === 400 || res.status === 403) {
      return { ok: false, ended: true };
    }
    if (!res.ok) return { ok: false, ended: false };
    const tokens = pick((await res.json()) as Record<string, unknown>);
    return tokens ? { ok: true, tokens } : { ok: false, ended: true };
  } catch {
    return { ok: false, ended: false };
  }
}
