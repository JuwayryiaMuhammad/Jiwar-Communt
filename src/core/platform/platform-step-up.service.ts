import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { SecurityEventsService } from '../audit/security-events.service';
import { IdentifierHasher } from '../auth/identifier';
import { OtpService } from '../auth/otp.service';
import { STEP_UP_TTL_MS } from '../auth/step-up.service';
import type { AppClsStore } from '../common/cls/app-cls';
import { appError, ErrorCode } from '../common/errors';
import type { Env } from '../config/env.schema';
import { GlobalDbService } from '../database/global-db.service';
import { RateLimitService } from '../redis/rate-limit.service';

/**
 * Platform step-up (ADR 0046): the tenant step-up (ADR 0036) for the
 * platform owner. A fresh code goes to the admin's own address, bound to
 * the platform session that asked (`stepUpKey('platform-session', sid)`):
 * another session cannot use it, and it never logs anyone in.
 *
 * - Verifying it sets `platform_sessions.step_up_until` (10 minutes).
 * - The action spends it in its own transaction (`consume`): one code, one
 *   action, and a rolled-back action leaves it usable.
 *
 * The password is the platform's only login factor, so the code adds a
 * second one before a compound's payment credentials change.
 */
@Injectable()
export class PlatformStepUpService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly cls: ClsService<AppClsStore>,
    private readonly globalDb: GlobalDbService,
    private readonly otp: OtpService,
    private readonly hasher: IdentifierHasher,
    private readonly rateLimit: RateLimitService,
    private readonly securityEvents: SecurityEventsService,
  ) {}

  /** Emails a code to the signed-in admin's own address. */
  async request(): Promise<void> {
    const { adminId, sessionId } = this.who();
    await this.limit(`platform-step-up:request:${sessionId}`);
    const admin = await this.globalDb.platformAdmin.findUniqueOrThrow({
      where: { id: adminId },
      select: { email: true, preferredLocale: true },
    });
    await this.otp.issueForStepUp(
      this.hasher.stepUpKey('platform-session', sessionId),
      adminId,
      admin.email,
      admin.preferredLocale,
    );
    await this.securityEvents.record('platform.step_up_requested', {
      platformAdminId: adminId,
      metadata: { sessionId },
    });
  }

  /** A right code opens the session for STEP_UP_TTL_MS; returns until when. */
  async verify(code: string): Promise<Date> {
    const { adminId, sessionId } = this.who();
    await this.limit(`platform-step-up:verify:${sessionId}`);
    const ok = await this.otp.verifyStepUp(
      this.hasher.stepUpKey('platform-session', sessionId),
      code,
    );
    if (!ok) {
      await this.securityEvents.record('platform.step_up_failed', {
        platformAdminId: adminId,
        metadata: { sessionId },
      });
      throw appError.forbidden(
        ErrorCode.STEP_UP_CODE_INVALID,
        'Invalid or expired code',
      );
    }
    const until = new Date(Date.now() + STEP_UP_TTL_MS);
    await this.globalDb.platformSession.updateMany({
      where: { id: sessionId, adminId, revokedAt: null },
      data: { stepUpUntil: until },
    });
    await this.securityEvents.record('platform.step_up_verified', {
      platformAdminId: adminId,
      metadata: { sessionId },
    });
    return until;
  }

  /**
   * Spends the session's step-up inside the action's transaction (a tenant
   * transaction of the compound it changes); throws STEP_UP_REQUIRED (403)
   * when there is none.
   */
  async consume(
    tx: Prisma.TransactionClient,
    now: Date = new Date(),
  ): Promise<void> {
    const adminId = this.cls.get('platformAdminId');
    const sessionId = this.cls.get('platformSessionId');
    const { count } =
      adminId && sessionId
        ? await this.globalDb.in(tx).platformSession.updateMany({
            where: {
              id: sessionId,
              adminId,
              revokedAt: null,
              stepUpUntil: { gt: now },
            },
            data: { stepUpUntil: null },
          })
        : { count: 0 };
    if (count !== 1) throw platformStepUpRequired();
  }

  private who(): { adminId: string; sessionId: string } {
    const adminId = this.cls.get('platformAdminId');
    const sessionId = this.cls.get('platformSessionId');
    if (!adminId || !sessionId) throw platformStepUpRequired();
    return { adminId, sessionId };
  }

  private limit(key: string): Promise<void> {
    return this.rateLimit.consume(
      key,
      this.config.get('OTP_RATE_LIMIT_PER_IDENTIFIER', { infer: true }),
      this.config.get('OTP_RATE_LIMIT_WINDOW_SECONDS', { infer: true }),
    );
  }
}

export function platformStepUpRequired() {
  return appError.forbidden(
    ErrorCode.STEP_UP_REQUIRED,
    'Confirm with a fresh code first (POST /platform/step-up)',
  );
}
