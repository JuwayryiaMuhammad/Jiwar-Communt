/**
 * What the proxy under /api lets through. The browser path is the backend
 * path without `/api/v1`: POST /api/public/not-me -> POST /api/v1/public/not-me.
 * Every route is a POST with a small JSON body carrying the link's token.
 */
const ROUTES: ReadonlySet<string> = new Set([
  'public/visitor-passes/lookup',
  'public/visitor-passes/not-me',
  'public/not-me',
  'public/data-exports/code',
  'public/data-exports/download',
  'invites/accept/start',
  'invites/accept/complete',
  'registrations/start',
  'registrations/complete',
  'public/receipts/lookup',
  'public/partner-desk/lookup',
  // A registrant's status page and a clearance check (ADR 0062).
  'public/registrations/status',
  'public/registrations/uploads',
  'public/registrations/resubmit',
  'public/clearances/lookup',
]);

/** A registrant's document, finalized or removed (ADR 0062). */
const REGISTRATION_DOCUMENT =
  /^public\/registrations\/documents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(finalize|remove)$/;

/**
 * A partner's desk actions (ADR 0060): the request's id is in the path, so
 * these are matched whole — one id, one of five verbs, nothing else.
 */
const DESK_ACTION =
  /^public\/partner-desk\/requests\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(accept|decline|propose|done|cancel)$/;

/** The largest body is the registration form; this is far above it. */
export const MAX_BODY_BYTES = 16 * 1024;

/** The backend path for the segments after /api, or null when not allowed. */
export function backendPath(segments: readonly string[]): string | null {
  const joined = segments.join('/');
  return ROUTES.has(joined) || DESK_ACTION.test(joined) || REGISTRATION_DOCUMENT.test(joined)
    ? `/api/v1/${joined}`
    : null;
}

export function isJson(contentType: string | null): boolean {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase() === 'application/json';
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]{2,39}(%[0-9a-z]{1,16})?$/i;

/**
 * The client's address for the API's per-IP limits: the right-most entry of
 * X-Forwarded-For, the one the reverse proxy in front of this app appended.
 * Everything to its left was sent by the client and is dropped, so a forged
 * chain cannot pick the address the API counts.
 */
export function clientIp(forwardedFor: string | null): string | null {
  if (!forwardedFor) return null;
  const last = forwardedFor.split(',').pop()!.trim();
  if (IPV4.test(last)) return last;
  if (last.includes(':') && IPV6.test(last)) return last;
  return null;
}

/** Request headers the backend gets, from the browser's. */
export function forwardedHeaders(get: (name: string) => string | null): Record<string, string> {
  const out: Record<string, string> = { 'content-type': 'application/json' };
  const language = get('accept-language');
  if (language && language.length <= 100) out['accept-language'] = language;
  const ip = clientIp(get('x-forwarded-for'));
  if (ip) out['x-forwarded-for'] = ip;
  return out;
}
