import { Injectable, Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { ClsService } from 'nestjs-cls';
import type { SecurityEventName } from '../../core/audit/actions';
import { SecurityEventsService } from '../../core/audit/security-events.service';
import type { AppClsStore } from '../../core/common/cls/app-cls';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { GlobalDbService } from '../../core/database/global-db.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { DriverError } from './vendor-call';

/** Failed calls an IP may make in a minute before every call is refused. */
export const VENDOR_WEBHOOK_FAILURES_PER_MINUTE = 30;

export interface VendorWebhookAnswer<T> {
  /** 200 handled (a replay included), 401 refused, 404 off, 500 call again. */
  status: 200 | 401 | 404 | 500;
  outcome?: T;
}

/**
 * A vendor's calls into a compound (ADR 0068: guard alarms, gate calls),
 * with the Paymob webhook's rules (ADR 0046). Public: the driver's
 * signature check is what authenticates a call. An off driver answers 404.
 * Every refusal is the same 401 — an unknown compound, a compound not
 * active, a signature that does not hold — and counts against the caller's
 * IP; past the limit, every call is refused unread. A failed signature is
 * a security event (compound only). Past it, the work runs in the
 * compound's transaction as the system; a failure is 500, so the vendor
 * calls again (its event id makes that a no-op once handled).
 *
 * This file opens compounds with runInTenantUnsafe (named in
 * eslint.config.mjs): a webhook has no request tenant.
 */
@Injectable()
export class VendorWebhooks {
  private readonly logger = new Logger(VendorWebhooks.name);

  constructor(
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly rateLimit: RateLimitService,
    private readonly securityEvents: SecurityEventsService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  async handle<V, T>(input: {
    service: 'alarm' | 'call';
    rejected: SecurityEventName;
    off: boolean;
    compoundId: string;
    ip: string;
    /** The driver's check: what the vendor said, or DriverError. */
    verify: () => V;
    process: (tx: TenantTxClient, tenantId: string, event: V) => Promise<T>;
  }): Promise<VendorWebhookAnswer<T>> {
    if (input.off) return { status: 404 };
    const limiter = `${input.service}-webhook:fail:${input.ip}`;
    if (
      await this.rateLimit.exceeded(limiter, VENDOR_WEBHOOK_FAILURES_PER_MINUTE)
    )
      return { status: 401 };
    const refuse = async (
      signature = false,
    ): Promise<VendorWebhookAnswer<T>> => {
      await this.rateLimit.hit(limiter, 60);
      if (signature)
        await this.securityEvents.record(input.rejected, {
          tenantId: input.compoundId,
        });
      return { status: 401 };
    };
    if (!isUUID(input.compoundId)) return refuse();
    const tenant = await this.globalDb.tenant.findUnique({
      where: { id: input.compoundId },
      select: { status: true },
    });
    if (tenant?.status !== 'active') return refuse();
    let event: V;
    try {
      event = input.verify();
    } catch (e) {
      if (e instanceof DriverError) return refuse(true);
      throw e;
    }
    try {
      const outcome = await this.cls.run({ ifNested: 'inherit' }, () => {
        this.cls.set('auditActor', { type: 'system', id: null });
        return this.tenantTx.runInTenantUnsafe(input.compoundId, (tx) =>
          input.process(tx, input.compoundId, event),
        );
      });
      return { status: 200, outcome };
    } catch (error) {
      this.logger.error(
        `${input.service} webhook failed (${error instanceof Error ? error.name : 'Error'})`,
      );
      return { status: 500 };
    }
  }
}
