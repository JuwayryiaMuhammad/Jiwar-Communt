import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PlatformAdmin } from '@prisma/client';
import { normalizeEmail } from '../auth/identifier';
import { diffChanges } from '../audit/diff';
import { PlatformAuditService } from '../audit/platform-audit.service';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../common/cls/app-cls';
import { appError, ErrorCode, FieldErrorCode } from '../common/errors';
import { sha256 } from '../common/refresh-token';
import type { Env } from '../config/env.schema';
import { GlobalDbService } from '../database/global-db.service';
import { RateLimitService } from '../redis/rate-limit.service';
import {
  dummyHash,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from './password';
import {
  PlatformSessionService,
  type PasswordChangeToken,
  type PlatformTokens,
} from './platform-session.service';

/**
 * Super admin authentication (ADR 0011). Every failure mode of `login` —
 * unknown email, wrong password, locked, disabled — is the same generic
 * error, and costs the same argon2 verification.
 */
@Injectable()
export class PlatformAuthService {
  private readonly maxFailures: number;
  private readonly lockoutSeconds: number;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly globalDb: GlobalDbService,
    private readonly sessions: PlatformSessionService,
    private readonly rateLimit: RateLimitService,
    private readonly cls: ClsService<AppClsStore>,
    private readonly platformAudit: PlatformAuditService,
  ) {
    this.maxFailures = config.get('PLATFORM_LOGIN_MAX_FAILURES', {
      infer: true,
    });
    this.lockoutSeconds = config.get('PLATFORM_LOCKOUT_SECONDS', {
      infer: true,
    });
  }

  async login(
    rawEmail: string,
    password: string,
    ip: string,
  ): Promise<PlatformTokens | PasswordChangeToken> {
    const email = normalizeEmail(rawEmail) ?? rawEmail.trim().toLowerCase();
    const window = this.config.get('PLATFORM_LOGIN_RATE_LIMIT_WINDOW_SECONDS', {
      infer: true,
    });
    await this.rateLimit.consume(
      `platform-login:ip:${ip}`,
      this.config.get('PLATFORM_LOGIN_RATE_LIMIT_PER_IP', { infer: true }),
      window,
    );
    await this.rateLimit.consume(
      `platform-login:email:${sha256(email)}`,
      this.config.get('PLATFORM_LOGIN_RATE_LIMIT_PER_EMAIL', { infer: true }),
      window,
    );

    const admin = await this.globalDb.platformAdmin.findUnique({
      where: { email },
    });
    const passwordOk = await verifyPassword(
      admin?.passwordHash ?? (await dummyHash()),
      password,
    );
    if (!admin) throw invalidCredentials();

    const locked = admin.lockedUntil !== null && admin.lockedUntil > new Date();
    if (!passwordOk) await this.recordFailure(admin);
    if (!passwordOk || locked || admin.status !== 'active') {
      throw invalidCredentials();
    }

    await this.globalDb.platformAdmin.update({
      where: { id: admin.id },
      data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    return admin.mustChangePassword
      ? this.sessions.passwordChangeToken(admin.id)
      : this.sessions.start(admin.id);
  }

  /**
   * For the admin in the request context (full or password-change token).
   * Revokes every platform session and starts a fresh one.
   */
  async changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<PlatformTokens> {
    const adminId = this.cls.isActive()
      ? this.cls.get('platformAdminId')
      : undefined;
    if (!adminId) throw unauthenticated();
    const admin = await this.globalDb.platformAdmin.findUnique({
      where: { id: adminId },
    });
    if (!admin || admin.status !== 'active') throw unauthenticated();

    if (!(await verifyPassword(admin.passwordHash, currentPassword))) {
      await this.recordFailure(admin);
      throw invalidCredentials();
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Password too short',
        {
          fields: [
            {
              field: 'newPassword',
              code: FieldErrorCode.INVALID_LENGTH,
              params: { min: MIN_PASSWORD_LENGTH },
            },
          ],
        },
      );
    }
    if (newPassword === currentPassword) {
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Password unchanged',
        {
          fields: [
            { field: 'newPassword', code: FieldErrorCode.SAME_AS_CURRENT },
          ],
        },
      );
    }

    const passwordHash = await hashPassword(newPassword);
    await this.globalDb.transaction(async (tx) => {
      await tx.platformAdmin.update({
        where: { id: admin.id },
        data: {
          passwordHash,
          mustChangePassword: false,
          failedAttempts: 0,
          lockedUntil: null,
        },
      });
      await this.platformAudit.record(tx, {
        action: 'platform_admin.password_changed',
        targetId: admin.id,
        changes: diffChanges(
          {
            passwordHash: admin.passwordHash,
            mustChangePassword: admin.mustChangePassword,
          },
          { passwordHash, mustChangePassword: false },
          'platform_admin.password_changed',
        ),
      });
    });
    await this.sessions.revokeAll(admin.id);
    return this.sessions.start(admin.id);
  }

  async refresh(refreshToken: string): Promise<PlatformTokens> {
    const session = await this.sessions.findLive(refreshToken);
    if (session) {
      const admin = await this.globalDb.platformAdmin.findUnique({
        where: { id: session.adminId },
      });
      if (admin?.status === 'active' && !admin.mustChangePassword) {
        const tokens = await this.sessions.rotate(session);
        if (tokens) return tokens;
      } else {
        await this.sessions.revoke(session.id);
      }
    }
    throw appError.unauthorized(
      ErrorCode.REFRESH_TOKEN_INVALID,
      'Invalid refresh token',
    );
  }

  async logout(refreshToken: string): Promise<void> {
    const session = await this.sessions.findLive(refreshToken);
    if (session) await this.sessions.revoke(session.id);
  }

  /** Counts a failure; reaching the limit locks the account for a while. */
  private async recordFailure(admin: PlatformAdmin): Promise<void> {
    const updated = await this.globalDb.platformAdmin.update({
      where: { id: admin.id },
      data: { failedAttempts: { increment: 1 } },
    });
    if (updated.failedAttempts >= this.maxFailures) {
      await this.globalDb.platformAdmin.update({
        where: { id: admin.id },
        data: {
          failedAttempts: 0,
          lockedUntil: new Date(Date.now() + this.lockoutSeconds * 1000),
        },
      });
    }
  }
}

function invalidCredentials() {
  return appError.unauthorized(
    ErrorCode.INVALID_CREDENTIALS,
    'Invalid credentials',
  );
}

function unauthenticated() {
  return appError.unauthorized(
    ErrorCode.UNAUTHENTICATED,
    'Authentication required',
  );
}
