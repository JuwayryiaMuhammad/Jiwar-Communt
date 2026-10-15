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
  let res: Response;
  try {
    res = await fetch(`/bff${path}?${qs}`, {
      credentials: 'same-origin',
      headers: { [BFF_HEADER]: '1' },
    });
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
