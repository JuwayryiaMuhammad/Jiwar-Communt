/**
 * Whether a request's Origin names the host the browser sent it to.
 *
 * `req.nextUrl.origin` is no good here: a standalone Next server builds it
 * from its bind address (HOSTNAME=0.0.0.0, PORT), never from the Host header,
 * so behind a reverse proxy it never matches a real browser's Origin. The
 * Host header is what the browser addressed, and a cross-site page cannot
 * choose it. Only the host is compared: the scheme is the proxy's business
 * (TLS ends there), and an http page on the same host is not a foreign site.
 */
export function isSameOrigin(origin: string, host: string | null): boolean {
  if (!host) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // `Origin: null` (sandboxed frames, some redirects) and garbage.
    return false;
  }
  return originHost !== '' && originHost.toLowerCase() === host.toLowerCase();
}
