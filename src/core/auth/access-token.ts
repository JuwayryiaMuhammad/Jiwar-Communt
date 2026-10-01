import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { IdentifierHasher } from './identifier';

/** `JWR1.` + 43 base64url characters: a versioned prefix the guard app knows. */
const QR_PREFIX = 'JWR1.';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A secret issued once: the token, the code derived from it, their HMACs. */
export interface IssuedToken {
  token: string;
  code: string;
  /** HMAC(pepper, "qr:<tenant>:<token>"), the gate's QR lookup. */
  qrHash: string;
}

/**
 * One secret per visitor pass and per worker engagement (ADR 0030): a
 * 32-byte random token. The short code is derived from it, so the link and
 * the printed card can show both the QR and the code while the server keeps
 * only HMACs. Core, because the community (workers) and gate (passes)
 * domains both issue them.
 */
@Injectable()
export class AccessTokens {
  constructor(private readonly hasher: IdentifierHasher) {}

  /** 32 random bytes, base64url (43 characters). */
  newToken(): string {
    return randomBytes(32).toString('base64url');
  }

  codeOf(token: string, digits: 6 | 8): string {
    return this.hasher.deriveCode(token, digits);
  }

  qrPayload(token: string): string {
    return `${QR_PREFIX}${token}`;
  }

  /** The token in a scanned payload, or null when it is not a Jiwar QR. */
  parseQr(raw: string): string | null {
    const value = raw.trim();
    if (!value.startsWith(QR_PREFIX)) return null;
    const token = value.slice(QR_PREFIX.length);
    return isToken(token) ? token : null;
  }

  /**
   * A fresh token whose derived code is free: a collision with another live
   * code means a new token, not a new code (there is no code of its own).
   */
  async issue(
    tenantId: string,
    digits: 6 | 8,
    isCodeTaken: (code: string) => Promise<boolean>,
  ): Promise<IssuedToken> {
    for (let i = 0; i < 10; i++) {
      const token = this.newToken();
      const code = this.codeOf(token, digits);
      if (await isCodeTaken(code)) continue;
      return { token, code, qrHash: this.hasher.hashQrToken(tenantId, token) };
    }
    // 10 collisions in a row among 10^6 (or 10^8) codes: something is wrong.
    throw new Error('No free access code after 10 tokens');
  }
}

/** The shape of a token, before any lookup. */
export function isToken(value: string): boolean {
  return TOKEN.test(value);
}
