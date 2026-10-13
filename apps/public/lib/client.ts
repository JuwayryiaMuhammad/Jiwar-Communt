import { fieldErrors, type FieldError } from './errors.ts';

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; fields: FieldError[] };

/**
 * POST to this app's own proxy (app/api). The token is in the body; the path
 * is fixed text, so nothing secret is ever part of a URL. No credentials,
 * no referrer, no cache.
 */
export async function post<T = undefined>(path: string, body: object, locale: string): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-language': locale, 'x-jiwar-bff': '1' },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
    });
  } catch {
    return { ok: false, status: 0, code: 'NETWORK', fields: [] };
  }
  let parsed: unknown;
  try {
    parsed = res.status === 204 ? undefined : await res.json();
  } catch {
    parsed = undefined;
  }
  if (res.ok) return { ok: true, status: res.status, data: parsed as T };
  const envelope = (parsed ?? {}) as { code?: unknown; fields?: unknown };
  return {
    ok: false,
    status: res.status,
    code: typeof envelope.code === 'string' ? envelope.code : 'generic',
    fields: fieldErrors(envelope.fields),
  };
}
