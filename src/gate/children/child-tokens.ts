import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isToken } from '../../core/auth/access-token';

/** `JWC1.<token>`: a child card's QR (ADR 0054). */
export const CHILD_CARD_PREFIX = 'JWC1.';

/** A child card's secret, issued once: its payload and its hash. */
export interface ChildCardSecret {
  qrPayload: string;
  tokenHash: string;
}

/**
 * `hex(SHA-256("jiwar:child-card:v1:<tenant>:<token>"))`. The token is 256
 * random bits, so a plain hash is enough, and no key is involved: a card is
 * printed and lives for years, and rotating a pepper or a key must never
 * kill every printed card. The label keeps it apart from every other hash
 * in the database, and the compound makes another compound's card unknown.
 */
export function childCardHash(tenantId: string, token: string): string {
  return createHash('sha256')
    .update(`jiwar:child-card:v1:${tenantId}:${token}`)
    .digest('hex');
}

export function issueChildCard(tenantId: string): ChildCardSecret {
  const token = randomBytes(32).toString('base64url');
  return {
    qrPayload: `${CHILD_CARD_PREFIX}${token}`,
    tokenHash: childCardHash(tenantId, token),
  };
}

/** The token of a scanned card, or null for anything else. */
export function parseChildCard(raw: string): string | null {
  const value = raw.trim();
  if (!value.startsWith(CHILD_CARD_PREFIX)) return null;
  const token = value.slice(CHILD_CARD_PREFIX.length);
  return isToken(token) ? token : null;
}

/** Whether `token` is the one behind `storedHash`, in constant time. */
export function childCardMatches(
  storedHash: string,
  tenantId: string,
  token: string,
): boolean {
  const a = Buffer.from(storedHash, 'utf8');
  const b = Buffer.from(childCardHash(tenantId, token), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
