import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SecurityEventsService } from '../audit/security-events.service';
import { ActionTokens } from '../auth/action-tokens';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode } from '../common/errors';
import { REASON_CODES } from '../common/reasons';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { RateLimitService } from '../redis/rate-limit.service';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { AccountLifecycle, runAfterCommit } from './account-lifecycle';
import { AccountWriter, type FreezeResult } from './account-writer';

/**
 * "Not me" on an unusual-login alert (ADR 0036), from the app (the alert's
 * device) or from the email's link (its token). It reuses the ADR 0023
 * freeze, with the reason `login_not_me`, which keeps the phone: the
 * account is frozen, every session and pending code ends, the domains react
 * (onFrozen: entry credentials end, a frozen primary's unit goes under
 * review), and the holder is told. The device is marked disowned. A
 * manager's reactivation reopens the account, with no new phone needed.
 *
 * Saying it twice, or about an account already frozen, changes nothing.
 */
@Injectable()
export class NotMeService implements OnModuleInit {
  private readonly logger = new Logger(NotMeService.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly writer: AccountWriter,
    private readonly tokens: ActionTokens,
    private readonly lifecycle: AccountLifecycle,
    private readonly rateLimit: RateLimitService,
    private readonly securityEvents: SecurityEventsService,
  ) {}

  onModuleInit(): void {
    // Erasure (ADR 0023): the devices and the links go with the account.
    this.lifecycle.onErasing(async (tx, account) => {
      await tx.knownDevice.deleteMany({ where: { accountId: account.id } });
      await this.globalDb
        .in(tx)
        .actionToken.deleteMany({ where: { accountId: account.id } });
      return [];
    });
  }

  /** From the app: the device the alert named, the caller's own. */
  async fromApp(deviceId: string): Promise<void> {
    const accountId = this.ctx.accountId;
    const tenantId = this.ctx.tenantId;
    const done = await this.tenantTx.withTenantTx(async (tx) => {
      const device = await tx.knownDevice.findFirst({
        where: { id: deviceId, accountId },
        select: { id: true },
      });
      if (!device) {
        throw appError.notFound(ErrorCode.DEVICE_NOT_FOUND, 'Device not found');
      }
      return this.freeze(tx, accountId, deviceId);
    });
    await this.after(done, { tenantId, accountId, deviceId, via: 'app' });
  }

  /** From the email's link: the token alone, used once. */
  async fromEmail(token: string, ip: string): Promise<void> {
    await this.rateLimit.consume(
      `not-me:ip:${ip}`,
      this.config.get('OTP_RATE_LIMIT_PER_IP', { infer: true }),
      this.config.get('OTP_RATE_LIMIT_WINDOW_SECONDS', { infer: true }),
    );
    const result = await this.tokens.inTokenTenant(
      token,
      'not_me',
      async (tx, row) => {
        await this.tokens.use(tx, row.id, 1);
        return {
          row,
          done: await this.freeze(tx, row.accountId, row.subjectId),
        };
      },
    );
    await this.after(result.done, {
      tenantId: result.row.tenantId,
      accountId: result.row.accountId,
      deviceId: result.row.subjectId,
      via: 'email_link',
    });
  }

  /**
   * The freeze itself, under the account row's lock (the writer's update).
   * Null when there was nothing to do.
   */
  private async freeze(
    tx: TenantTxClient,
    accountId: string,
    deviceId: string,
  ): Promise<FreezeResult | null> {
    await tx.$queryRaw`
      SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR UPDATE`;
    await tx.knownDevice.updateMany({
      where: { id: deviceId, accountId, disownedAt: null },
      data: { disownedAt: new Date() },
    });
    const account = await tx.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { status: true },
    });
    if (account.status !== 'active') return null;
    return this.writer.freeze(
      tx,
      accountId,
      { code: REASON_CODES.accountFreezeSelf[0], text: '' },
      'login_not_me',
    );
  }

  private async after(
    done: FreezeResult | null,
    who: {
      tenantId: string;
      accountId: string;
      deviceId: string;
      via: 'app' | 'email_link';
    },
  ): Promise<void> {
    if (!done) return;
    await runAfterCommit(done.afterCommit, this.logger);
    await this.securityEvents.record('account.not_me', {
      tenantId: who.tenantId,
      accountId: who.accountId,
      metadata: {
        via: who.via,
        deviceId: who.deviceId,
        sessionsRevoked: done.sessionsRevoked,
      },
    });
  }
}
