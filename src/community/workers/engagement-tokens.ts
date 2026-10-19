import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessTokens } from '../../core/auth/access-token';
import { IdentifierHasher } from '../../core/auth/identifier';
import {
  engagementTokenKeyRing,
  type EngagementTokenKeyRing,
} from '../../core/config/engagement-token-keys';
import type { Env } from '../../core/config/env.schema';

/**
 * The token behind a worker card (ADR 0057):
 * `base64url(HMAC-SHA256(key_v, "engagement:<tenant>:<engagementId>:<seq>"))`,
 * 43 characters like a random one. Derived, so the gate's offline bundle
 * can carry what a device needs to know the card while the server stores
 * only its HMACs (ADR 0030); there is still no route that shows a card
 * again.
 */
export function deriveEngagementToken(
  key: string,
  tenantId: string,
  engagementId: string,
  seq: number,
): string {
  return createHmac('sha256', key)
    .update(`engagement:${tenantId}:${engagementId}:${seq}`)
    .digest()
    .toString('base64url');
}

/** One card's secret: the token, its code, their stored HMACs, and how it was derived. */
export interface CardSecret {
  seq: number;
  keyVersion: number;
  token: string;
  code: string;
  codeHash: string;
  qrHash: string;
}

/**
 * Worker card secrets (ADR 0030, 0057). The code is `deriveCode(token, 8)`
 * and the QR `JWR1.<token>`: the gate sees no difference between a derived
 * token and a random one.
 *
 * Key-versioned: a card records the version it was derived with, new and
 * reissued cards take the current one, and every version stays in the ring
 * while a card needs it. A rotation never kills a printed card: the gate
 * looks a card up by its stored HMAC, and the bundle derives it with its
 * own version.
 */
@Injectable()
export class EngagementTokens {
  private readonly ring: EngagementTokenKeyRing;

  constructor(
    config: ConfigService<Env, true>,
    private readonly hasher: IdentifierHasher,
    private readonly tokens: AccessTokens,
  ) {
    this.ring = engagementTokenKeyRing({
      ENGAGEMENT_TOKEN_KEYS: config.get('ENGAGEMENT_TOKEN_KEYS', {
        infer: true,
      }),
      ENGAGEMENT_TOKEN_KEY_VERSION: config.get('ENGAGEMENT_TOKEN_KEY_VERSION', {
        infer: true,
      }),
    });
  }

  /** The version new and reissued cards are derived with. */
  get currentVersion(): number {
    return this.ring.current.version;
  }

  /** The secret of (engagement, seq) under a version; null when the ring lost it. */
  secretOf(
    tenantId: string,
    engagementId: string,
    seq: number,
    keyVersion: number = this.ring.current.version,
  ): CardSecret | null {
    const key = this.ring.byVersion.get(keyVersion);
    if (!key) return null;
    const token = deriveEngagementToken(key, tenantId, engagementId, seq);
    const code = this.tokens.codeOf(token, 8);
    return {
      seq,
      keyVersion,
      token,
      code,
      codeHash: this.hasher.hashWorkerCode(tenantId, code),
      qrHash: this.hasher.hashQrToken(tenantId, token),
    };
  }

  /**
   * The live card of an engagement, or null: a card issued before ADR 0057
   * (random, no `tokenSeq`), one whose version left the ring, or one whose
   * derived hashes no longer match the stored ones. Its code still opens
   * the gate online.
   */
  liveSecret(e: {
    tenantId: string;
    id: string;
    tokenSeq: number | null;
    tokenKeyVersion: number | null;
    accessCodeHash: string | null;
    qrTokenHash: string | null;
  }): CardSecret | null {
    if (
      e.tokenSeq === null ||
      e.tokenKeyVersion === null ||
      e.accessCodeHash === null ||
      e.qrTokenHash === null
    )
      return null;
    const secret = this.secretOf(
      e.tenantId,
      e.id,
      e.tokenSeq,
      e.tokenKeyVersion,
    );
    return secret &&
      secret.codeHash === e.accessCodeHash &&
      secret.qrHash === e.qrTokenHash
      ? secret
      : null;
  }
}
