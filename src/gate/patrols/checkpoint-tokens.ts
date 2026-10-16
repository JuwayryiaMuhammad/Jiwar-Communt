import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isToken } from '../../core/auth/access-token';

/** `JWK1.<checkpointId>.<token>`: a checkpoint's QR and NFC tag (ADR 0052). */
export const CHECKPOINT_QR_PREFIX = 'JWK1.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A checkpoint's secret, issued once: the token, its payload and its hash. */
export interface CheckpointSecret {
  token: string;
  qrPayload: string;
  tokenHash: string;
}

/** 32 random bytes, base64url (43 characters), as a pass's token. */
export function newCheckpointToken(): string {
  return randomBytes(32).toString('base64url');
}

export function checkpointPayload(checkpointId: string, token: string): string {
  return `${CHECKPOINT_QR_PREFIX}${checkpointId}.${token}`;
}

/**
 * `hex(SHA-256("jiwar:patrol-checkpoint:v1:<tenant>:<checkpointId>:<token>"))`.
 * The token is 256 random bits, so a plain hash is enough, and no key is
 * involved: rotating a pepper or a key must never kill every printed QR.
 * The label keeps it apart from every other hash in the database.
 */
export function checkpointTokenHash(
  tenantId: string,
  checkpointId: string,
  token: string,
): string {
  return createHash('sha256')
    .update(`jiwar:patrol-checkpoint:v1:${tenantId}:${checkpointId}:${token}`)
    .digest('hex');
}

export function issueCheckpointSecret(
  tenantId: string,
  checkpointId: string,
): CheckpointSecret {
  const token = newCheckpointToken();
  return {
    token,
    qrPayload: checkpointPayload(checkpointId, token),
    tokenHash: checkpointTokenHash(tenantId, checkpointId, token),
  };
}

/**
 * The checkpoint id and token of a scanned payload, or null for anything
 * else. Read as the app reads it: surrounding spaces ignored, the id in
 * lower case.
 */
export function parseCheckpointPayload(
  raw: string,
): { checkpointId: string; token: string } | null {
  const value = raw.trim();
  if (!value.startsWith(CHECKPOINT_QR_PREFIX)) return null;
  const rest = value.slice(CHECKPOINT_QR_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot < 0) return null;
  const checkpointId = rest.slice(0, dot).toLowerCase();
  const token = rest.slice(dot + 1);
  if (!UUID.test(checkpointId) || !isToken(token)) return null;
  return { checkpointId, token };
}

/** Whether `token` is the one behind `storedHash`, in constant time. */
export function checkpointTokenMatches(
  storedHash: string,
  tenantId: string,
  checkpointId: string,
  token: string,
): boolean {
  const a = Buffer.from(storedHash, 'utf8');
  const b = Buffer.from(
    checkpointTokenHash(tenantId, checkpointId, token),
    'utf8',
  );
  return a.length === b.length && timingSafeEqual(a, b);
}
