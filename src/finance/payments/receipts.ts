import { createHash, randomBytes } from 'node:crypto';

/**
 * A receipt's verification code (ADR 0046, ported from Jiwar-Hub): 128
 * random bits as 22 base64url characters. Uniqueness rests on the
 * randomness and a unique index; a malformed code is refused before any
 * read.
 */
export const RECEIPT_CODE = /^[A-Za-z0-9_-]{22}$/;

export function newReceiptCode(): string {
  return randomBytes(16).toString('base64url');
}

/** What the global pointer stores: the code's SHA-256, never the code. */
export function receiptCodeHash(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** The public page that verifies a receipt; the code stays in the fragment. */
export function receiptUrl(publicAppUrl: string, code: string): string {
  return `${publicAppUrl}/receipt#${code}`;
}
