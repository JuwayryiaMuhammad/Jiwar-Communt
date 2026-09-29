import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AccountType } from '@prisma/client';
import type { AccessTokenClaims } from '../common/guards/access-token';
import {
  newSecret,
  parseRefreshToken,
  safeEqualHex,
  sha256,
} from '../common/refresh-token';
import { AuditContext } from '../audit/audit-context';
import { SecurityEventsService } from '../audit/security-events.service';
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
    private readonly securityEvents: SecurityEventsService,
    private readonly context: AuditContext,
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
        ...this.origin(),
      },
    });
    return {
      ...(await this.accessToken(account, sessionId)),
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
      await this.reuseDetected(session, 'old_secret');
      return null;
    }
    return session;
  }

  /** Swaps the refresh secret. Null if another refresh won the race. */
  async rotate(
    session: {
      id: string;
      accountId: string;
      tenantId: string;
      refreshTokenHash: string;
      expiresAt: Date;
    },
    account: SessionAccount,
  ): Promise<IssuedTokens | null> {
    const secret = newSecret();
    const { count } = await this.globalDb.session.updateMany({
      where: {
        id: session.id,
        refreshTokenHash: session.refreshTokenHash,
        revokedAt: null,
      },
      data: { refreshTokenHash: sha256(secret), ...this.origin() },
    });
    if (count === 0) {
      await this.revoke(session.id);
      await this.reuseDetected(session, 'concurrent_rotation');
      return null;
    }
    return {
      ...(await this.accessToken(account, session.id)),
      refreshToken: `${session.id}.${secret}`,
      refreshTokenExpiresAt: session.expiresAt,
    };
  }

  /** A rotated refresh token came back: the session is presumed stolen. */
  private async reuseDetected(
    session: { id: string; accountId: string; tenantId: string },
    how: 'old_secret' | 'concurrent_rotation',
  ): Promise<void> {
    const who = { accountId: session.accountId, tenantId: session.tenantId };
    await this.securityEvents.record('session.refresh_reuse_detected', {
      ...who,
      metadata: { sessionId: session.id, how },
    });
    await this.securityEvents.record('session.revoked', {
      ...who,
      metadata: { reason: 'refresh_reuse', sessionId: session.id },
    });
  }

  async revoke(sessionId: string): Promise<void> {
    await this.globalDb.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Where the session is used from, and when (start and every refresh). */
  private origin() {
    const { ip, userAgent } = this.context.origin();
    return { ip, userAgent, lastUsedAt: new Date() };
  }

  private async accessToken(account: SessionAccount, sessionId: string) {
    const { accessTtlSeconds } = SESSION_POLICY[account.accountType];
    const claims: AccessTokenClaims = {
      sub: account.accountId,
      tid: account.tenantId,
      typ: account.accountType,
      sid: sessionId,
    };
    return {
      accessToken: await this.jwt.signAsync(claims, {
        expiresIn: accessTtlSeconds,
      }),
      accessTokenExpiresIn: accessTtlSeconds,
    };
  }
}
