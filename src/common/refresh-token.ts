import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isUUID } from 'class-validator';

// Refresh tokens are `<sessionId>.<secret>`: a 256-bit random secret, stored
// only as SHA-256. Shared by tenant sessions (auth/) and platform sessions
// (platform/), which follow the same rotation and reuse-detection rules.

export function parseRefreshToken(
  token: string,
): { sessionId: string; secret: string } | null {
  const [sessionId, secret, ...rest] = token.split('.');
  if (rest.length || !sessionId || !secret || !isUUID(sessionId)) return null;
  return { sessionId, secret };
}

export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}
