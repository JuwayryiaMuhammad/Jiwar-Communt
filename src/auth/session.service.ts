import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AccountType } from '@prisma/client';
import { isUUID } from 'class-validator';
import type { AccessTokenClaims } from '../common/guards/access-token';
import { newId } from '../common/uuid';
import { GlobalDbService } from '../database/global-db.service';
import { SESSION_POLICY } from './auth-policy';

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface SessionAccount {
  accountId: string;
  tenantId: string;
  accountType: AccountType;
}

/**
 * Access tokens (short-lived JWT) and refresh tokens (`<sessionId>.<secret>`,
 * 256-bit secret stored as SHA-256 in `sessions`, rotated on every use).
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly jwt: JwtService,
    private readonly globalDb: GlobalDbService,
  ) {}

  async start(account: SessionAccount): Promise<IssuedTokens> {
    const policy = SESSION_POLICY[account.accountType];
    const sessionId = newId();
    const secret = newSecret();
    const refreshTokenExpiresAt = new Date(
      Date.now() + policy.refreshTtlSeconds * 1000,
    );
    await this.globalDb.session.create({
      data: {
        id: sessionId,
        accountId: account.accountId,
        tenantId: account.tenantId,
        refreshTokenHash: sha256(secret),
        expiresAt: refreshTokenExpiresAt,
      },
    });
    return {
      ...(await this.accessToken(account)),
      refreshToken: `${sessionId}.${secret}`,
      refreshTokenExpiresAt,
    };
  }

  /**
   * Looks up a live session by refresh token. A wrong secret for a live
   * session means an old, rotated token is being replayed: the session is
   * revoked (reuse detection).
   */
  async findLive(refreshToken: string) {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) return null;
    const session = await this.globalDb.session.findUnique({
      where: { id: parsed.sessionId },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date())
      return null;
    if (!safeEqualHex(sha256(parsed.secret), session.refreshTokenHash)) {
      await this.revoke(session.id);
      return null;
    }
    return session;
  }

  /** Swaps the refresh secret. Null if another refresh won the race. */
  async rotate(
    session: { id: string; refreshTokenHash: string; expiresAt: Date },
    account: SessionAccount,
  ): Promise<IssuedTokens | null> {
    const secret = newSecret();
    const { count } = await this.globalDb.session.updateMany({
      where: {
        id: session.id,
        refreshTokenHash: session.refreshTokenHash,
        revokedAt: null,
      },
      data: { refreshTokenHash: sha256(secret), lastUsedAt: new Date() },
    });
    if (count === 0) {
      await this.revoke(session.id);
      return null;
    }
    return {
      ...(await this.accessToken(account)),
      refreshToken: `${session.id}.${secret}`,
      refreshTokenExpiresAt: session.expiresAt,
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.globalDb.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async accessToken(account: SessionAccount) {
    const { accessTtlSeconds } = SESSION_POLICY[account.accountType];
    const claims: AccessTokenClaims = {
      sub: account.accountId,
      tid: account.tenantId,
      typ: account.accountType,
    };
    return {
      accessToken: await this.jwt.signAsync(claims, {
        expiresIn: accessTtlSeconds,
      }),
      accessTokenExpiresIn: accessTtlSeconds,
    };
  }
}

function parseRefreshToken(
  token: string,
): { sessionId: string; secret: string } | null {
  const [sessionId, secret, ...rest] = token.split('.');
  if (rest.length || !sessionId || !secret || !isUUID(sessionId)) return null;
  return { sessionId, secret };
}

function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}
