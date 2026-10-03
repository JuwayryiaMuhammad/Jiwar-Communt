'use client';

import { ApiError, BFF_HEADER, createApiClient, type ApiErrorBody } from '@jiwar/api';

function toLogin() {
  if (typeof window === 'undefined') return;
  const here = window.location.pathname;
  if (here === '/login') return;
  window.location.assign(`/login?next=${encodeURIComponent(here)}`);
}

/** Typed client for the compound API, through this app's BFF. */
export const api = createApiClient({ baseUrl: '/bff', onUnauthenticated: toLogin });

/** The BFF's own auth routes (/bff/auth/*), outside the OpenAPI contract. */
export async function bffAuth<T = unknown>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/bff/auth/${path}`, {
      method,
      credentials: 'same-origin',
      headers: { [BFF_HEADER]: '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw ApiError.from(0, undefined);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!res.ok) throw ApiError.from(res.status, parsed as ApiErrorBody);
  return parsed as T;
}
