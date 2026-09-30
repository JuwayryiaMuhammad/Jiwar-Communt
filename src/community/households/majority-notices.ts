import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../../core/audit/audit.service';
import type { AppClsStore } from '../../core/common/cls/app-cls';
import {
  adultCutoff,
  isAdult,
  localToday,
} from '../../core/common/egyptian-national-id';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { COMMUNITY_NOTICES } from '../notices/community-notices';
import { CommunityNotifier } from '../notices/community-notifier';

export const MAJORITY_SWEEP = 'household.majority_notices';

/**
 * A minor reaching 18 (05 §7, ADR 0021). The status is never raised
 * automatically: this only TELLS the primary (and records the minor's
 * notice as undeliverable — a minor has no account), once per member, on
 * the birthday in the compound's own time zone. The primary then confirms
 * by inviting the member to an account of their own.
 *
 * Runs from the in-app sweep, compound by compound, as `system`. The claim
 * (`majority_notified_at IS NULL` → now) makes it safe to run twice or on
 * several instances.
 */
@Injectable()
export class MajorityNotices implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly cls: ClsService<AppClsStore>,
    private readonly audit: AuditService,
    private readonly notifier: CommunityNotifier,
  ) {}

  onModuleInit(): void {
    this.sweep.register(MAJORITY_SWEEP, (now) => this.processDue(now));
  }

  async processDue(now: Date = new Date()): Promise<number> {
    const tenants = await this.globalDb.tenant.findMany({
      where: { status: 'active' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    let told = 0;
    for (const t of tenants) {
      told += await this.cls.run({ ifNested: 'inherit' }, () => {
        this.cls.set('auditActor', { type: 'system', id: null });
        return this.tenantTx.runInTenantUnsafe(t.id, (tx) =>
          this.inTenant(tx, t.id, now),
        );
      });
    }
    return told;
  }

  private async inTenant(
    tx: TenantTxClient,
    tenantId: string,
    now: Date,
  ): Promise<number> {
    const settings = await tx.tenantSettings.findUnique({
      where: { tenantId },
      select: { timezone: true },
    });
    const today = localToday(settings?.timezone ?? 'Africa/Cairo', now);
    const due = await tx.householdMember.findMany({
      where: {
        isMinor: true,
        status: 'active',
        majorityNotifiedAt: null,
        birthDate: { lte: adultCutoff(today) },
      },
    });
    let told = 0;
    for (const m of due) {
      if (!isAdult(m.birthDate, today)) continue;
      const { count } = await tx.householdMember.updateMany({
        where: { id: m.id, majorityNotifiedAt: null },
        data: { majorityNotifiedAt: now },
      });
      if (count === 0) continue; // another instance told them
      told++;
      const primary = await tx.unitOccupancy.findFirst({
        where: { unitId: m.unitId, status: 'active', isPrimary: true },
        select: { accountId: true },
      });
      const place = await this.notifier.place(tx, tenantId, m.unitId);
      if (primary) {
        await this.notifier.toAccounts(
          tx,
          tenantId,
          [primary.accountId],
          COMMUNITY_NOTICES.majorityReached,
          { ...place, memberName: m.fullName ?? '' },
        );
      } else {
        await this.notifier.undeliverable(
          tx,
          tenantId,
          COMMUNITY_NOTICES.majorityReached,
        );
      }
      // The minor has no account: their notice is on file, undelivered.
      await this.notifier.undeliverable(
        tx,
        tenantId,
        COMMUNITY_NOTICES.majorityReached,
      );
      await this.audit.record(tx, {
        action: 'household.member_majority_reached',
        targetId: m.id,
        metadata: {
          unitId: m.unitId,
          primaryTold: primary !== null,
          noticeUndeliverable: true,
        },
      });
    }
    return told;
  }
}
