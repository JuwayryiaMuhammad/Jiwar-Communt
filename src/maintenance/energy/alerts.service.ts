import { Injectable } from '@nestjs/common';
import type { MeterAlert } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { ticketNumber } from '../tickets/ticket-rules';
import { dbNow } from '../db-clock';

const PAGE = keysetCursor('createdAt', 'desc');

/**
 * The meters' spike alerts (ADR 0066): read with `energy.read`, the newest
 * first; acknowledged once with `energy.manage`, under the alert's lock.
 */
@Injectable()
export class MeterAlertsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  list(q: {
    meterId?: string;
    open?: 'true' | 'false';
    cursor?: string;
    limit?: number;
  }): Promise<Page<MeterAlert>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.meterAlert.findMany({
        where: {
          AND: [
            q.meterId ? { meterId: q.meterId } : {},
            q.open === 'true'
              ? { acknowledgedAt: null }
              : q.open === 'false'
                ? { acknowledgedAt: { not: null } }
                : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  acknowledge(id: string): Promise<MeterAlert> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM meter_alerts WHERE id = ${id}::uuid FOR UPDATE`;
      const alert = await tx.meterAlert.findUnique({ where: { id } });
      if (!alert)
        throw appError.notFound(
          ErrorCode.METER_ALERT_NOT_FOUND,
          'Alert not found',
        );
      if (alert.acknowledgedAt)
        throw appError.conflict(
          ErrorCode.METER_ALERT_ACKNOWLEDGED,
          'This alert is acknowledged already',
        );
      const after = await tx.meterAlert.update({
        where: { id },
        data: {
          acknowledgedAt: await dbNow(tx),
          acknowledgedById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'meter_alert.acknowledged',
        targetId: id,
        metadata: { meterId: alert.meterId },
      });
      return after;
    });
  }

  /**
   * A staff work order answers this alert (ADR 0076), in the caller's
   * transaction: the alert under its lock (a second work order for it
   * waits, then sees the first: METER_ALERT_HAS_WORK_ORDER), acknowledged
   * now if nobody had. Its meter, for the work order's place.
   */
  async claimForWorkOrder(
    tx: TenantTxClient,
    id: string,
  ): Promise<{
    meterId: string;
    assetId: string | null;
    commonAreaId: string | null;
  }> {
    await tx.$queryRaw`SELECT id FROM meter_alerts WHERE id = ${id}::uuid FOR UPDATE`;
    const alert = await tx.meterAlert.findUnique({ where: { id } });
    if (!alert)
      throw appError.notFound(
        ErrorCode.METER_ALERT_NOT_FOUND,
        'Alert not found',
      );
    const held = await tx.ticket.findFirst({
      where: { meterAlertId: id },
      select: { number: true },
    });
    if (held)
      throw appError.conflict(
        ErrorCode.METER_ALERT_HAS_WORK_ORDER,
        'This alert has its work order already',
        { params: { ticketNumber: ticketNumber(held.number) } },
      );
    if (!alert.acknowledgedAt) {
      await tx.meterAlert.update({
        where: { id },
        data: {
          acknowledgedAt: await dbNow(tx),
          acknowledgedById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'meter_alert.acknowledged',
        targetId: id,
        metadata: { meterId: alert.meterId, by: 'work_order' },
      });
    }
    const meter = await tx.meter.findUniqueOrThrow({
      where: { id: alert.meterId },
      select: { assetId: true, commonAreaId: true },
    });
    return {
      meterId: alert.meterId,
      assetId: meter.assetId,
      commonAreaId: meter.commonAreaId,
    };
  }
}
