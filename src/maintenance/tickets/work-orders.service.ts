import { Injectable } from '@nestjs/common';
import type { Ticket, TicketPriority } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { categoryNotFound } from '../categories/categories.service';
import { MeterAlertsService } from '../energy/alerts.service';
import { lockOpenCase } from '../analytics/cases.service';
import { TicketAccess } from './ticket-access';
import { ticketNumber } from './ticket-rules';
import { TICKET_RESOURCE, TicketsService } from './tickets.service';

export interface NewStaffWorkOrder {
  assetId?: string;
  commonAreaId?: string;
  meterAlertId?: string;
  /** ADR 0081: the community case it is the one work order of. */
  caseId?: string;
  categoryId: string;
  priority?: TicketPriority;
  description: string;
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Validation failed', {
    fields,
  });

/**
 * The management's own work orders (ADR 0076): a fault seen on a walk, a
 * device, a meter's spike. Opened by `tickets.dispatch` on an asset or a
 * common area, through the one work-order path every origin takes
 * (`createWorkOrder`: the asset shared-locked and in service, its place the
 * ticket's), and dispatched like any repair once committed. Its reporter and
 * creator are the dispatcher who opened it; the SLA measures it.
 *
 * For a spike, the alert is taken under its lock first: one work order per
 * alert, the alert acknowledged with it if nobody had, and the meter's asset
 * or area the place unless the body names one.
 *
 * For a community case (ADR 0081), `caseId`: once the work order is written
 * (under the ticket counter's lock), the case is locked, still open and
 * without one, and takes it (MAINTENANCE_CASE_HAS_WORK_ORDER otherwise):
 * the counter, then the case, the order every writer of a case keeps.
 */
@Injectable()
export class WorkOrdersService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly tickets: TicketsService,
    private readonly access: TicketAccess,
    private readonly idempotency: IdempotencyService,
    private readonly alerts: MeterAlertsService,
  ) {}

  async open(input: NewStaffWorkOrder): Promise<Ticket> {
    if (input.assetId && input.commonAreaId)
      throw invalid([
        { field: 'commonAreaId', code: FieldErrorCode.FIELD_NOT_ALLOWED },
      ]);
    const ticket = await this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: TICKET_RESOURCE, id });
      await this.access.lockSelf(tx);
      return this.openIn(tx, id, input);
    });
    await this.tickets.dispatchAfterCommit([ticket.id]);
    return this.tenantTx.withTenantTx((tx) =>
      tx.ticket.findUniqueOrThrow({ where: { id: ticket.id } }),
    );
  }

  /**
   * `open` inside the caller's transaction, the caller's account locked
   * already (ADR 0080: a management request about a common area or an
   * asset, converted into the management's own work order). The caller
   * dispatches it once committed.
   */
  async openIn(
    tx: TenantTxClient,
    id: string,
    input: NewStaffWorkOrder,
  ): Promise<Ticket> {
    if (input.assetId && input.commonAreaId)
      throw invalid([
        { field: 'commonAreaId', code: FieldErrorCode.FIELD_NOT_ALLOWED },
      ]);
    const me = this.ctx.accountId;
    let assetId = input.assetId;
    let commonAreaId = input.commonAreaId;
    if (input.meterAlertId) {
      const meter = await this.alerts.claimForWorkOrder(tx, input.meterAlertId);
      if (!assetId && !commonAreaId) {
        assetId = meter.assetId ?? undefined;
        commonAreaId = meter.assetId
          ? undefined
          : (meter.commonAreaId ?? undefined);
      }
    }
    if (!assetId && !commonAreaId)
      throw invalid([
        { field: 'assetId', code: FieldErrorCode.FIELD_REQUIRED },
      ]);
    if (assetId && !(await tx.asset.findUnique({ where: { id: assetId } })))
      throw appError.notFound(ErrorCode.ASSET_NOT_FOUND, 'Asset not found');
    if (
      commonAreaId &&
      !(await tx.commonArea.findFirst({
        where: { id: commonAreaId, active: true },
      }))
    )
      throw appError.notFound(
        ErrorCode.COMMON_AREA_NOT_FOUND,
        'Common area not found',
      );
    const category = await tx.ticketCategory.findFirst({
      where: { id: input.categoryId, active: true },
    });
    if (!category) throw categoryNotFound();
    const opened = await this.tickets.createWorkOrder(tx, {
      id,
      tenantId: this.ctx.tenantId,
      origin: 'staff',
      ...(assetId ? { assetId } : { commonAreaId }),
      categoryId: category.id,
      priority: input.priority ?? category.defaultPriority,
      description: input.description,
      responsibleId: me,
      actorId: me,
      ...(input.meterAlertId ? { meterAlertId: input.meterAlertId } : {}),
      ...(input.caseId ? { caseId: input.caseId } : {}),
    });
    if (input.caseId) {
      const c = await lockOpenCase(tx, input.caseId);
      if (c.workOrderTicketId) {
        const held = await tx.ticket.findUniqueOrThrow({
          where: { id: c.workOrderTicketId },
          select: { number: true },
        });
        throw appError.conflict(
          ErrorCode.MAINTENANCE_CASE_HAS_WORK_ORDER,
          'This case has its work order already',
          { params: { ticketNumber: ticketNumber(held.number) } },
        );
      }
      await tx.maintenanceCase.update({
        where: { id: input.caseId },
        data: { workOrderTicketId: opened.id },
      });
    }
    return opened;
  }
}
