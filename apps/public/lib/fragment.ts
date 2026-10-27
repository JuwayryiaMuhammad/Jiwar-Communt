/**
 * The secret of a link is its fragment (ADR 0030, ADR 0036): the browser
 * never sends it to a server. These are the shapes the API issues; anything
 * else is shown the invalid-link page without a request.
 */
export type LinkKind =
  | 'visitor'
  | 'action'
  | 'invite'
  | 'registration'
  | 'registrationStatus'
  | 'receipt'
  | 'clearance'
  | 'desk';

const SHAPES: Record<LinkKind, RegExp> = {
  // 32 random bytes, base64url. The QR's `JWR1.` prefix is not part of it.
  visitor: /^[A-Za-z0-9_-]{43}$/,
  // <uuid>.<64 hex>
  action: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{64}$/,
  // base64url today; the API accepts up to 200 characters.
  invite: /^[A-Za-z0-9_-]{16,200}$/,
  registration: /^[A-Za-z0-9_-]{16,200}$/,
  // A registrant's status link (ADR 0062): an HMAC, 64 hex characters.
  registrationStatus: /^[0-9a-f]{64}$/,
  // A receipt's verification code (ADR 0046): 16 random bytes, base64url.
  receipt: /^[A-Za-z0-9_-]{22}$/,
  // A clearance certificate's code (ADR 0062): as a receipt's.
  clearance: /^[A-Za-z0-9_-]{22}$/,
  // A partner's desk link (ADR 0060): 32 random bytes, base64url.
  desk: /^[A-Za-z0-9_-]{43}$/,
};

/** The token in `location.hash`, or null when there is none of this kind. */
export function parseFragment(hash: string, kind: LinkKind): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  return SHAPES[kind].test(raw) ? raw : null;
}
