'use client';

import { ApiError, BFF_HEADER, type ApiErrorBody } from '@jiwar/api';
import { downloadName } from '@/components/finance/logic';

/**
 * Saves a CSV export (ADR 0048) through this app's BFF. A plain link would
 * be refused (the BFF answers only its own app's requests), so the page
 * fetches it with the BFF's header and hands the bytes to the browser,
 * under the name the server gave.
 */
export async function download(
  path: string,
  query: Record<string, string | undefined>,
  fallback: string,
): Promise<void> {
  const qs = new URLSearchParams(
    Object.entries(query).filter((e): e is [string, string] => Boolean(e[1])),
  );
  return save(`/bff${path}?${qs}`, { credentials: 'same-origin', headers: { [BFF_HEADER]: '1' } }, fallback);
}

/**
 * The same for an export asked in a body (ADR 0079: the gate log's, so a
 * visitor's name never travels in a URL).
 */
export async function downloadPost(path: string, body: object, fallback: string): Promise<void> {
  return save(
    `/bff${path}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { [BFF_HEADER]: '1', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    fallback,
  );
}

async function save(target: string, init: Parameters<typeof fetch>[1], fallback: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(target, init);
  } catch {
    throw ApiError.from(0, undefined);
  }
  if (!res.ok) {
    let body: ApiErrorBody | undefined;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      body = undefined;
    }
    throw ApiError.from(res.status, body);
  }
  const url = URL.createObjectURL(await res.blob());
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName(res.headers.get('content-disposition'), fallback);
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
