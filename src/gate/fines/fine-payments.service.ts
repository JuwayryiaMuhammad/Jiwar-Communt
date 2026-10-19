import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type VehicleFinePayment } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { VehicleCore } from '../vehicles/vehicle-core';
import { asDate, dayOf } from '../vehicles/vehicle-rules';
import { CURRENCY, PAID_ON_DAYS } from './fine-rules';
import { FinesService } from './fines.service';
import { FinePaymentView } from './views/fine.views';

export const FINE_PAYMENT_RESOURCE = 'vehicle_fine_payment';

export interface NewFinePayment {
  amount: string;
  currency?: string;
  receiptNumber: string;
  paidOn: LocalDate;
}

const paymentNotFound = () =>
  appError.notFound(ErrorCode.FINE_PAYMENT_NOT_FOUND, 'Payment not found');

/**
 * A fine's payment at the office (ADR 0045), `fines.billing` (the
 * accountant): append-only records, as the club's (ADR 0044). The fine's
 * row is locked for every write, so a fine holds at most one payment
 * without a reversal, and is `paid` exactly while it does. No online
 * payment (R6), no partial one.
 */
@Injectable()
export class FinePaymentsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly core: VehicleCore,
    private readonly fines: FinesService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(FINE_PAYMENT_RESOURCE, async (id) =>
      FinePaymentView.from(
        await this.tenantTx.withTenantTx((tx) =>
          tx.vehicleFinePayment.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
  }

  /**
   * Records the fine's payment: unpaid and not under appeal, the whole
   * amount, a receipt number (once among the compound's fine payments) and
   * the local day it was paid (not ahead, at most 90 days ago, not before
   * the fine's day).
   */
  record(fineId: string, input: NewFinePayment): Promise<VehicleFinePayment> {
    if ((input.currency ?? CURRENCY) !== CURRENCY)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid request',
        {
          fields: [{ field: 'currency', code: FieldErrorCode.INVALID_VALUE }],
        },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: FINE_PAYMENT_RESOURCE, id });
      await this.core.lockSelf(tx);
      const fine = await this.fines.lockRow(tx, fineId);
      if (fine.status === 'under_appeal')
        throw appError.conflict(
          ErrorCode.FINE_UNDER_APPEAL,
          'The fine is under appeal: it is paid once decided',
        );
      // Appealed to the board (ADR 0055): paid once the board decides.
      if (fine.boardAppealAt && !fine.boardAppealClosedAt)
        throw appError.conflict(
          ErrorCode.FINE_UNDER_APPEAL,
          'The fine is appealed to the board: it is paid once decided',
          { params: { level: 'board' } },
        );
      if (fine.status !== 'unpaid')
        throw appError.conflict(
          ErrorCode.FINE_NOT_PAYABLE,
          'The fine takes no payment',
          { params: { status: fine.status } },
        );
      const amount = new Prisma.Decimal(input.amount);
      const { today } = await this.core.clock(tx);
      const occurred = dayOf(fine.occurredOn)!;
      const floor = addDays(today, -PAID_ON_DAYS);
      const min = occurred > floor ? occurred : floor;
      const fields: FieldError[] = [
        ...(amount.equals(fine.amount)
          ? []
          : [
              {
                field: 'amount',
                code: FieldErrorCode.AMOUNT_MISMATCH,
                params: { amount: fine.amount.toFixed(2) },
              },
            ]),
        ...(input.paidOn > today || input.paidOn < min
          ? [
              {
                field: 'paidOn',
                code: FieldErrorCode.PAID_ON_OUT_OF_RANGE,
                params: { min, max: today },
              },
            ]
          : []),
      ];
      if (fields.length)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Invalid request',
          { fields },
        );
      const payment = await tx.vehicleFinePayment.create({
        data: {
          id,
          tenantId: fine.tenantId,
          fineId,
          kind: 'payment',
          amount,
          currency: CURRENCY,
          receiptNumber: input.receiptNumber,
          paidOn: asDate(input.paidOn),
          recordedById: this.ctx.accountId,
        },
      });
      await tx.vehicleFine.update({
        where: { id: fineId },
        data: { status: 'paid' },
      });
      await this.audit.record(tx, {
        action: 'vehicle_fine.payment_recorded',
        targetId: id,
        metadata: {
          fineId,
          unitId: fine.unitId,
          amount: amount.toFixed(2),
          currency: CURRENCY,
          receiptNumber: input.receiptNumber,
          paidOn: input.paidOn,
        },
      });
      return payment;
    });
  }

  /** A payment recorded by mistake is reversed, once: the fine is unpaid again. */
  reverse(
    paymentId: string,
    reasonCode: string | undefined,
  ): Promise<VehicleFinePayment> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.vehicleFinePaymentReverse,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: FINE_PAYMENT_RESOURCE, id });
      await this.core.lockSelf(tx);
      const seen = await tx.vehicleFinePayment.findUnique({
        where: { id: paymentId },
      });
      if (seen?.kind !== 'payment') throw paymentNotFound();
      const fine = await this.fines.lockRow(tx, seen.fineId);
      const already = await tx.vehicleFinePayment.findFirst({
        where: { reversesId: paymentId },
        select: { id: true },
      });
      if (already)
        throw appError.conflict(
          ErrorCode.FINE_PAYMENT_ALREADY_REVERSED,
          'This payment was reversed already',
        );
      const reversal = await tx.vehicleFinePayment.create({
        data: {
          id,
          tenantId: fine.tenantId,
          fineId: fine.id,
          kind: 'reversal',
          reversesId: paymentId,
          reasonCode: reason,
          recordedById: this.ctx.accountId,
        },
      });
      await tx.vehicleFine.update({
        where: { id: fine.id },
        data: { status: 'unpaid' },
      });
      await this.audit.record(tx, {
        action: 'vehicle_fine.payment_reversed',
        targetId: id,
        metadata: {
          fineId: fine.id,
          unitId: fine.unitId,
          reversesId: paymentId,
          reasonCode: reason,
        },
      });
      return reversal;
    });
  }
}
