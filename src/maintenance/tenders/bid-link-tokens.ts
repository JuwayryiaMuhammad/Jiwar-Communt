import { createHash, randomBytes } from 'node:crypto';

// ============================================================================
// A tender's bid link (ADR 0088)
// ============================================================================
//
// The desk links' rules (ADR 0060, 0057): a long random token, 32 bytes,
// base64url (43 characters); the server keeps only SHA-256 of it with a
// domain label of its own, so a leaked table opens no bid page and a desk
// token never opens one. The link carries it in the fragment,
// `<PUBLIC_APP_URL>/b#<token>`, which never reaches a server log; the page
// posts it in a body.

const LABEL = 'jiwar:tender-bid:v1:';
const SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** A new token, shown once. */
export function newBidToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database keeps of a token: lowercase hex. */
export function bidTokenHash(token: string): string {
  return createHash('sha256').update(`${LABEL}${token}`).digest('hex');
}

/** Whether a string has the shape of a bid token (checked before any read). */
export function isBidToken(value: unknown): value is string {
  return typeof value === 'string' && SHAPE.test(value);
}

/** The link the management gives the company. */
export function bidLink(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, '')}/b#${token}`;
}
