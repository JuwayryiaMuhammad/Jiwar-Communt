import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityFinancePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { addDays } from '../../core/common/slots/day-slots';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { FormalNotices } from '../../core/formal-notices/formal-notices.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FinanceAccess } from '../access';
import { formatNumber } from '../counters';
import { localToday } from '../db-clock';
import { money } from '../money';
import {
  CREDITED_SQL,
  DISPUTED_SQL,
  PAID_SQL,
  RESCHEDULED_SQL,
} from '../invoices/balances';

export const LATE_NOTICES_SWEEP = 'finance.late_notices';
/** The cure period's bounds, in days after the due date (ADR 0058). */
export const CURE_DAYS = { min: 0, max: 60 } as const;
const BATCH = 200;

/**
 * The formal late-payment notice (ADR 0058). An invoice still owed after
 * its due date and the compound's cure period (`late_notice_cure_days`, 14
 * by default) gets one formal notice to the unit's finance holders, with
 * its proofs (ADR 0058's formal notices). The `invoice.overdue` reminder
 * (ADR 0046) stays the friendly one, the day after the due date.
 *
 * Not while it is disputed or rescheduled. Under the unit's finance lock, a
 * payment, a credit note or a dispute that commits first leaves nothing to
 * notice; one that comes after waits for the notice. Once per invoice.
 */
@Injectable()
export class LateNoticesService implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly tenantSettings: TenantSettingsService,
    private readonly access: FinanceAccess,
    private readonly community: CommunityFinancePort,
    private readonly notices: FormalNotices,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(LATE_NOTICES_SWEEP, () => this.run());
  }

  /** Notices issued. */
  run(): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { status: true },
        });
        if (tenant?.status !== 'active') return [];
        const { timezone } = await this.tenantSettings.inTx(tx, tenantId);
        const cure = (
          await tx.financeSettings.findUnique({
            where: { tenantId },
            select: { lateNoticeCureDays: true },
          })
        )?.lateNoticeCureDays;
        if (cure === undefined) return [];
        const last = addDays(await localToday(tx, timezone), -cure - 1);
        return tx.$queryRaw<{ id: string; unitId: string }[]>`
          SELECT i.id, i.unit_id AS "unitId"
            FROM invoices i
           WHERE i.due_on <= ${last}::date
             AND i.total - ${CREDITED_SQL} - ${PAID_SQL} > 0
             AND NOT ${DISPUTED_SQL}
             AND NOT ${RESCHEDULED_SQL}
             AND NOT EXISTS (
               SELECT 1 FROM formal_notices n
                WHERE n.tenant_id = i.tenant_id AND n.type = 'late_payment'
                  AND n.subject_type = 'invoice' AND n.subject_id = i.id)
           ORDER BY i.due_on, i.number LIMIT ${BATCH}`;
      },
      async (tx, _tenantId, item) => {
        await this.access.lockUnits(tx, [item.unitId]);
        // Judged again under the lock: what committed first counts.
        const [row] = await tx.$queryRaw<
          {
            number: number;
            due_on: Date;
            outstanding: string;
            noticeable: boolean;
          }[]
        >`
          SELECT i.number, i.due_on,
                 (i.total - ${CREDITED_SQL} - ${PAID_SQL})::text AS outstanding,
                 (i.total - ${CREDITED_SQL} - ${PAID_SQL}) > 0
                   AND NOT ${DISPUTED_SQL} AND NOT ${RESCHEDULED_SQL} AS noticeable
            FROM invoices i WHERE i.id = ${item.id}::uuid`;
        if (!row?.noticeable) return 0;
        const issued = await this.notices.issue(tx, {
          type: 'late_payment',
          unitId: item.unitId,
          subjectType: 'invoice',
          subjectId: item.id,
          subjectNumber: formatNumber('invoice', row.number),
          amount: money(row.outstanding),
          dueOn: row.due_on.toISOString().slice(0, 10),
          recipients: await this.community.financeHolders(tx, item.unitId),
        });
        return issued ? 1 : 0;
      },
    );
  }

  cureDays(): Promise<number> {
    return this.tenantTx.withTenantTx(
      async (tx) =>
        (
          await tx.financeSettings.findUniqueOrThrow({
            where: { tenantId: this.ctx.tenantId },
            select: { lateNoticeCureDays: true },
          })
        ).lateNoticeCureDays,
    );
  }

  /** Applies to the notices not yet issued. */
  setCureDays(days: number): Promise<number> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await tx.$queryRaw`
        SELECT tenant_id FROM finance_settings
         WHERE tenant_id = ${this.ctx.tenantId}::uuid FOR UPDATE`;
      const before = await tx.financeSettings.findUniqueOrThrow({
        where: { tenantId: this.ctx.tenantId },
        select: { lateNoticeCureDays: true },
      });
      if (before.lateNoticeCureDays === days) return days;
      await tx.financeSettings.update({
        where: { tenantId: this.ctx.tenantId },
        data: { lateNoticeCureDays: days },
      });
      await this.audit.record(tx, {
        action: 'finance.notice_settings_changed',
        targetId: this.ctx.tenantId,
        changes: diffChanges(
          before,
          { lateNoticeCureDays: days },
          'finance.notice_settings_changed',
        ),
      });
      return days;
    });
  }
}
