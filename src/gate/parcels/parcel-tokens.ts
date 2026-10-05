import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IdentifierHasher } from '../../core/auth/identifier';
import { isToken } from '../../core/auth/access-token';
import type { Env } from '../../core/config/env.schema';

/** `JWP1.` + 43 base64url characters: a parcel's QR, apart from `JWR1.` (ADR 0035). */
export const PARCEL_QR_PREFIX = 'JWP1.';

/** Tokens tried for one credential before a free code is given up on. */
const MAX_ATTEMPTS = 10;

/**
 * The token behind a parcel credential (ADR 0035):
 * `base64url(HMAC-SHA256(PARCEL_TOKEN_KEY, "parcel:<tenant>:<credentialId>:<attempt>"))`,
 * 43 characters like a pass's token. Derived, so the residents' views can
 * show the code again while the server stores only its HMACs.
 */
export function deriveParcelToken(
  key: string,
  tenantId: string,
  credentialId: string,
  attempt: number,
): string {
  return createHmac('sha256', key)
    .update(`parcel:${tenantId}:${credentialId}:${attempt}`)
    .digest()
    .toString('base64url');
}

/** What a credential's token gives: the code, the QR and their stored HMACs. */
export interface ParcelSecret {
  token: string;
  code: string;
  qrPayload: string;
  codeHash: string;
  qrTokenHash: string;
}

/**
 * Parcel codes and QRs. The code is `deriveCode(token)`, as for passes
 * (ADR 0030); the hashes carry their own HMAC labels, so a parcel's code is
 * never a visitor's or a worker's.
 */
@Injectable()
export class ParcelTokens {
  private readonly key: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly hasher: IdentifierHasher,
  ) {
    this.key = config.get('PARCEL_TOKEN_KEY', { infer: true });
  }

  /** Everything one (credential, attempt) gives. */
  secretOf(
    tenantId: string,
    credentialId: string,
    attempt: number,
  ): ParcelSecret {
    const token = deriveParcelToken(this.key, tenantId, credentialId, attempt);
    const code = this.hasher.deriveCode(token, 6);
    return {
      token,
      code,
      qrPayload: `${PARCEL_QR_PREFIX}${token}`,
      codeHash: this.hasher.hashParcelCode(tenantId, code),
      qrTokenHash: this.hasher.hashParcelQr(tenantId, token),
    };
  }

  /** The hash a typed code is looked up by, in its compound. */
  codeHashOf(tenantId: string, code: string): string {
    return this.hasher.hashParcelCode(tenantId, code);
  }

  /** The hash a scanned QR's token is looked up by, in its compound. */
  qrHashOf(tenantId: string, token: string): string {
    return this.hasher.hashParcelQr(tenantId, token);
  }

  /** The token in a scanned `JWP1.` payload, or null when it is not one. */
  parseQr(raw: string): string | null {
    const value = raw.trim();
    if (!value.startsWith(PARCEL_QR_PREFIX)) return null;
    const token = value.slice(PARCEL_QR_PREFIX.length);
    return isToken(token) ? token : null;
  }

  /**
   * The first attempt whose code is free: a collision with another live
   * code of the compound gives a new token (the next attempt), never a new
   * code. `isTaken` is asked with the code's hash.
   */
  async allocate(
    tenantId: string,
    credentialId: string,
    isTaken: (codeHash: string) => Promise<boolean>,
  ): Promise<{ attempt: number } & ParcelSecret> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const secret = this.secretOf(tenantId, credentialId, attempt);
      if (await isTaken(secret.codeHash)) continue;
      return { attempt, ...secret };
    }
    // 10 collisions in a row among 10^6 codes: something is wrong.
    throw new Error('No free parcel code after 10 tokens');
  }
}
