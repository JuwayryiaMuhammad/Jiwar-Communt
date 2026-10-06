import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecurityEventsService } from '../audit/security-events.service';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode } from '../common/errors';
import type { Env } from '../config/env.schema';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { RateLimitService } from '../redis/rate-limit.service';
import { IdentifierHasher } from './identifier';
import { OtpService } from './otp.service';

/** How long a verified step-up lets the session's next sensitive action run. */
export const STEP_UP_TTL_MS = 10 * 60_000;

/**
 * Step-up (ADR 0036): a fresh one-time code, emailed to the account's own
 * address, before a sensitive action (a personal-data export).
 *
 * - The code is bound to the session that asked for it
 *   (`stepUpKey('session', sid)`): another session, even of the same
 *   account, cannot use it, and it can never log anyone in.
 * - Verifying it sets `sessions.step_up_until` (10 minutes).
 * - The action consumes it in its own transaction (`consume`), so one code
 *   allows one action, and a rolled-back action leaves it usable.
 */
@Injectable()
export class StepUpService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly otp: OtpService,
    private readonly hasher: IdentifierHasher,
    private readonly rateLimit: RateLimitService,
    private readonly securityEvents: SecurityEventsService,
  ) {}

  /** Emails a code to the caller's own address. */
  async request(): Promise<void> {
    const sessionId = this.session();
    await this.limit(`step-up:request:${sessionId}`);
    const account = await this.tenantTx.withTenantTx((tx) =>
      tx.account.findUniqueOrThrow({
        where: { id: this.ctx.accountId },
        select: { email: true, preferredLocale: true },
      }),
    );
    if (!account.email) throw stepUpRequired();
    await this.otp.issueForStepUp(
      this.hasher.stepUpKey('session', sessionId),
      this.ctx.accountId,
      account.email,
      account.preferredLocale,
    );
    await this.securityEvents.record('step_up.requested', {
      tenantId: this.ctx.tenantId,
      accountId: this.ctx.accountId,
      metadata: { sessionId },
    });
  }

  /** A right code opens the session for STEP_UP_TTL_MS; returns until when. */
  async verify(code: string): Promise<Date> {
    const sessionId = this.session();
    await this.limit(`step-up:verify:${sessionId}`);
    const ok = await this.otp.verifyStepUp(
      this.hasher.stepUpKey('session', sessionId),
      code,
    );
    const who = { tenantId: this.ctx.tenantId, accountId: this.ctx.accountId };
    if (!ok) {
      await this.securityEvents.record('step_up.failed', {
        ...who,
        metadata: { sessionId },
      });
      throw appError.forbidden(
        ErrorCode.STEP_UP_CODE_INVALID,
        'Invalid or expired code',
      );
    }
    const until = new Date(Date.now() + STEP_UP_TTL_MS);
    await this.globalDb.session.updateMany({
      where: { id: sessionId, accountId: this.ctx.accountId, revokedAt: null },
      data: { stepUpUntil: until },
    });
    await this.securityEvents.record('step_up.verified', {
      ...who,
      metadata: { sessionId },
    });
    return until;
  }

  /**
   * Spends the session's step-up inside the action's transaction; throws
   * STEP_UP_REQUIRED (403) when there is none.
   */
  async consume(tx: TenantTxClient, now: Date = new Date()): Promise<void> {
    const sessionId = this.ctx.sessionIdOrNull();
    const { count } = sessionId
      ? await this.globalDb.in(tx).session.updateMany({
          where: {
            id: sessionId,
            accountId: this.ctx.accountId,
            revokedAt: null,
            stepUpUntil: { gt: now },
          },
          data: { stepUpUntil: null },
        })
      : { count: 0 };
    if (count !== 1) throw stepUpRequired();
  }

  private session(): string {
    const id = this.ctx.sessionIdOrNull();
    if (!id) throw stepUpRequired();
    return id;
  }

  private limit(key: string): Promise<void> {
    return this.rateLimit.consume(
      key,
      this.config.get('OTP_RATE_LIMIT_PER_IDENTIFIER', { infer: true }),
      this.config.get('OTP_RATE_LIMIT_WINDOW_SECONDS', { infer: true }),
    );
  }
}

export function stepUpRequired() {
  return appError.forbidden(
    ErrorCode.STEP_UP_REQUIRED,
    'Confirm with a fresh code first (POST /me/step-up)',
  );
}
