import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { PlatformSession } from '@prisma/client';
import {
  newSecret,
  parseRefreshToken,
  safeEqualHex,
  sha256,
} from '../common/refresh-token';
import { SecurityEventsService } from '../audit/security-events.service';
import { newId } from '../common/uuid';
import { GlobalDbService } from '../database/global-db.service';
import { PLATFORM_JWT } from './platform-jwt';
import {
  PASSWORD_CHANGE_TTL_SECONDS,
  PLATFORM_ACCESS_TTL_SECONDS,
  PLATFORM_REFRESH_TTL_SECONDS,
  type PlatformTokenClaims,
} from './platform-policy';

export interface PlatformTokens {
  scope: 'full';
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface PasswordChangeToken {
  scope: 'password_change';
  accessToken: string;
  accessTokenExpiresIn: number;
}

/** Same rotation and reuse-detection rules as tenant sessions (ADR 0004). */
@Injectable()
export class PlatformSessionService {
  constructor(
    @Inject(PLATFORM_JWT) private readonly jwt: JwtService,
    private readonly globalDb: GlobalDbService,
    private readonly securityEvents: SecurityEventsService,
  ) {}

  async start(adminId: string): Promise<PlatformTokens> {
    const sessionId = newId();
    const secret = newSecret();
    const refreshTokenExpiresAt = new Date(
      Date.now() + PLATFORM_REFRESH_TTL_SECONDS * 1000,
    );
    await this.globalDb.platformSession.create({
      data: {
        id: sessionId,
        adminId,
        refreshTokenHash: sha256(secret),
        expiresAt: refreshTokenExpiresAt,
      },
    });
    return {
      scope: 'full',
      accessToken: await this.sign({
        sub: adminId,
        scp: 'full',
        sid: sessionId,
      }),
      accessTokenExpiresIn: PLATFORM_ACCESS_TTL_SECONDS,
      refreshToken: `${sessionId}.${secret}`,
      refreshTokenExpiresAt,
    };
  }

  /** Valid only for changing the password; no session, no refresh. */
  async passwordChangeToken(adminId: string): Promise<PasswordChangeToken> {
    return {
      scope: 'password_change',
      accessToken: await this.jwt.signAsync(
        { sub: adminId, scp: 'password_change' } satisfies PlatformTokenClaims,
        { expiresIn: PASSWORD_CHANGE_TTL_SECONDS },
      ),
      accessTokenExpiresIn: PASSWORD_CHANGE_TTL_SECONDS,
    };
  }

  /** A replayed (rotated) secret revokes the session. */
  async findLive(refreshToken: string): Promise<PlatformSession | null> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) return null;
    const session = await this.globalDb.platformSession.findUnique({
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

  async rotate(session: PlatformSession): Promise<PlatformTokens | null> {
    const secret = newSecret();
    const { count } = await this.globalDb.platformSession.updateMany({
      where: {
        id: session.id,
        refreshTokenHash: session.refreshTokenHash,
        revokedAt: null,
      },
      data: { refreshTokenHash: sha256(secret), lastUsedAt: new Date() },
    });
    if (count === 0) {
      await this.revoke(session.id);
      await this.reuseDetected(session, 'concurrent_rotation');
      return null;
    }
    return {
      scope: 'full',
      accessToken: await this.sign({
        sub: session.adminId,
        scp: 'full',
        sid: session.id,
      }),
      accessTokenExpiresIn: PLATFORM_ACCESS_TTL_SECONDS,
      refreshToken: `${session.id}.${secret}`,
      refreshTokenExpiresAt: session.expiresAt,
    };
  }

  /** True while the session behind a full access token is still live. */
  async isLive(sessionId: string): Promise<boolean> {
    const session = await this.globalDb.platformSession.findUnique({
      where: { id: sessionId },
      select: { revokedAt: true, expiresAt: true },
    });
    return !!session && !session.revokedAt && session.expiresAt > new Date();
  }

  private async reuseDetected(
    session: PlatformSession,
    how: 'old_secret' | 'concurrent_rotation',
  ): Promise<void> {
    await this.securityEvents.record('session.refresh_reuse_detected', {
      platformAdminId: session.adminId,
      metadata: { sessionId: session.id, how },
    });
    await this.securityEvents.record('session.revoked', {
      platformAdminId: session.adminId,
      metadata: { reason: 'refresh_reuse', sessionId: session.id },
    });
  }

  async revoke(sessionId: string): Promise<void> {
    await this.globalDb.platformSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAll(adminId: string): Promise<void> {
    await this.globalDb.platformSession.updateMany({
      where: { adminId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private sign(claims: PlatformTokenClaims): Promise<string> {
    return this.jwt.signAsync(claims, {
      expiresIn: PLATFORM_ACCESS_TTL_SECONDS,
    });
  }
}
