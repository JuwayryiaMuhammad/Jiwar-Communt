import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessTokens } from '../../core/auth/access-token';
import { IdentifierHasher } from '../../core/auth/identifier';
import type { Env } from '../../core/config/env.schema';

/**
 * The token behind a visitor pass (ADR 0043):
 * `base64url(HMAC-SHA256(VISITOR_PASS_TOKEN_KEY, "pass:<tenant>:<passId>:<seq>"))`,
 * 43 characters like before. Derived, so the host's views can show the code,
 * the QR and the link again while the server stores only their HMACs.
 */
export function derivePassToken(
  key: string,
  tenantId: string,
  passId: string,
  seq: number,
): string {
  return createHmac('sha256', key)
    .update(`pass:${tenantId}:${passId}:${seq}`)
    .digest()
    .toString('base64url');
}

/** One (pass, seq)'s secret: the token, its code and their stored HMACs. */
export interface PassSecret {
  seq: number;
  token: string;
  code: string;
  codeHash: string;
  qrHash: string;
}

/**
 * Visitor pass secrets (ADR 0030, 0043). The code is `deriveCode(token)` and
 * the QR `JWR1.<token>`, as before: the gate and the public page see no
 * difference between a derived token and a random one.
 */
@Injectable()
export class PassTokens {
  private readonly key: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly hasher: IdentifierHasher,
    private readonly tokens: AccessTokens,
  ) {
    this.key = config.get('VISITOR_PASS_TOKEN_KEY', { infer: true });
  }

  secretOf(tenantId: string, passId: string, seq: number): PassSecret {
    const token = derivePassToken(this.key, tenantId, passId, seq);
    const code = this.tokens.codeOf(token, 6);
    return {
      seq,
      token,
      code,
      codeHash: this.hasher.hashVisitorCode(tenantId, code),
      qrHash: this.hasher.hashQrToken(tenantId, token),
    };
  }

  /**
   * The live secret of an active pass, or null: a pass issued before
   * (no `tokenSeq`), or one whose derived code no longer matches its stored
   * hash (the key was rotated). Its code still opens the gate.
   */
  liveSecret(pass: {
    tenantId: string;
    id: string;
    tokenSeq: number | null;
    codeHash: string | null;
  }): PassSecret | null {
    if (pass.tokenSeq === null || pass.codeHash === null) return null;
    const secret = this.secretOf(pass.tenantId, pass.id, pass.tokenSeq);
    return secret.codeHash === pass.codeHash ? secret : null;
  }
}
