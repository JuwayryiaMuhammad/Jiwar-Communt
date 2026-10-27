/**
 * Where a page may connect. Every page talks to this app only; the
 * registrant's status page (/rs, ADR 0062) also PUTs a document straight to
 * storage with the URL the API signed, so it alone adds `UPLOAD_ORIGIN`.
 * The value must be a bare origin, or it is ignored: it goes into a header.
 */
export function connectSrc(pathname: string, uploadOrigin: string | undefined, dev: boolean): string {
  const sources = ["'self'"];
  if (dev) sources.push('ws:');
  const origin = pathname === '/rs' ? bareOrigin(uploadOrigin) : null;
  if (origin) sources.push(origin);
  return `connect-src ${sources.join(' ')}`;
}

function bareOrigin(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.origin === value.replace(/\/$/, '') ? url.origin : null;
}
