import { createHash, randomBytes } from 'node:crypto';

// ============================================================================
// A partner's desk link (ADR 0060)
// ============================================================================
//
// A long random token: 32 bytes, base64url (43 characters). The server keeps
// only SHA-256 of it with a domain label (the token rules of ADR 0057: long
// random values are hashed with a label, short codes are keyed HMACs), so
// no key is needed and a leaked table opens no desk. The link carries it in
// the fragment, `<PUBLIC_APP_URL>/p#<token>`, which never reaches a server
// log; the page posts it in a body.

const LABEL = 'jiwar:partner-desk:v1:';
const SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** A new token, shown once. */
export function newDeskToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database keeps of a token: lowercase hex. */
export function deskTokenHash(token: string): string {
  return createHash('sha256').update(`${LABEL}${token}`).digest('hex');
}

/** Whether a string has the shape of a desk token (checked before any read). */
export function isDeskToken(value: unknown): value is string {
  return typeof value === 'string' && SHAPE.test(value);
}

/** The link the management gives the partner. */
export function deskLink(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, '')}/p#${token}`;
}
