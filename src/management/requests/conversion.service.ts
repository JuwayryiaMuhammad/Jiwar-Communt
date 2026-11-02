import { Injectable } from '@nestjs/common';
import type { TicketPriority } from '@prisma/client';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  MaintenanceManagementPort,
  type ConvertedTicket,
} from '../../maintenance';
import { dbNow } from '../db-clock';
import { RequestLifecycle } from './lifecycle.service';
import { RequestAccess } from './request-access';
import { assertCan } from './request-rules';

/** What a request becomes (ADR 0080). */
export const CONVERT_TARGETS = ['ticket', 'work_order'] as const;
export type ConvertTarget = (typeof CONVERT_TARGETS)[number];

export interface ConvertRequest {
  /**
   * `ticket`: the resident's own ticket in the request's unit, they its
   * reporter. `work_order`: the management's work order on a common area
   * or an asset, for a fault the resident reported outside their unit.
   */
  target: ConvertTarget;
  categoryId: string;
  priority?: TicketPriority;
  /** Staff's words for the ticket: what is to be done. */
  description: string;
  /** A work order's place: exactly one. */
  commonAreaId?: string;
  assetId?: string;
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

/**
 * A request turned into a maintenance ticket (ADR 0080, `requests.handle`
 * and `tickets.dispatch`): in one transaction, under the request's row lock,
 * the ticket is opened through maintenance's own paths (a resident's ticket
 * on their behalf, ADR 0032, or the management's work order, ADR 0076) and
 * the request closes `converted`, pointing at it; the resident is told its
 * number. Two converts of one request: the second finds it closed
 * (MANAGEMENT_REQUEST_INVALID_TRANSITION) and opens nothing. The ticket is
 * dispatched once the transaction has committed.
 */
@Injectable()
export class RequestConversion {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly access: RequestAccess,
    private readonly lifecycle: RequestLifecycle,
    private readonly maintenance: MaintenanceManagementPort,
  ) {}

  async convert(id: string, input: ConvertRequest): Promise<ConvertedTicket> {
    this.assertShape(input);
    const ticket = await this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const request = await this.access.load(tx, id, 'staff', { lock: true });
      assertCan(request, 'close');
      const ticketId = newId();
      let opened: ConvertedTicket;
      if (input.target === 'ticket') {
        // A resident's ticket is in the unit the request is about.
        if (!request.unitId)
          throw invalid([
            { field: 'target', code: FieldErrorCode.INVALID_VALUE },
          ]);
        opened = await this.maintenance.openForResident(tx, ticketId, {
          reporterAccountId: request.authorId,
          unitId: request.unitId,
          categoryId: input.categoryId,
          priority: input.priority,
          description: input.description,
        });
      } else {
        opened = await this.maintenance.openWorkOrder(tx, ticketId, {
          ...(input.assetId
            ? { assetId: input.assetId }
            : { commonAreaId: input.commonAreaId }),
          categoryId: input.categoryId,
          priority: input.priority,
          description: input.description,
        });
      }
      await this.lifecycle.closeConverted(tx, request, opened, await dbNow(tx));
      return opened;
    });
    await this.maintenance.dispatchAfterCommit(ticket.id);
    return ticket;
  }

  /** A ticket names no place (the request's unit is it); a work order one. */
  private assertShape(input: ConvertRequest): void {
    const errors: FieldError[] = [];
    if (input.target === 'ticket') {
      if (input.commonAreaId !== undefined)
        errors.push({
          field: 'commonAreaId',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
      if (input.assetId !== undefined)
        errors.push({
          field: 'assetId',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
    } else if (
      (input.assetId === undefined) ===
      (input.commonAreaId === undefined)
    )
      errors.push({
        field: input.assetId === undefined ? 'commonAreaId' : 'assetId',
        code:
          input.assetId === undefined
            ? FieldErrorCode.FIELD_REQUIRED
            : FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    if (errors.length) throw invalid(errors);
  }
}
