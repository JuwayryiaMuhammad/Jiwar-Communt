import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import {
  addDays,
  localDate,
  type LocalDate,
} from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { PAID_ON_DAYS } from '../fines/fine-rules';
import { SafetyCore } from '../safety/safety-core';
import { dayOf } from '../vehicles/vehicle-rules';
import { StaffViolationView } from './views/violation.views';
import {
  asDate,
  CURRENCY,
  ViolationsService,
  type ViolationFile,
} from './violations.service';

export const VIOLATION_PAYMENT_RESOURCE = 'violation_payment';

export interface NewViolationPayment {
  amount: string;
  currency?: string;
  receiptNumber: string;
  paidOn: LocalDate;
}

const paymentNotFound = () =>
  appError.notFound(
    ErrorCode.VIOLATION_NOT_FOUND,
    'Violation payment not found',
  );

/**
 * A violation's payment at the office (ADR 0053), `fines.billing` (the
 * accountant), exactly as a fine's (ADR 0045): append-only records; the
 * violation's row is locked for every write, so it holds at most one
 * payment without a reversal, and is `paid` exactly while it does. A
 * warning is never paid; one under appeal waits for the decision (and an
 * appeal waits for a payment's write: one wins). No online payment yet.
 */
@Injectable()
export class ViolationPaymentsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly settings: TenantSettingsService,
    private readonly safety: SafetyCore,
    private readonly violations: ViolationsService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(VIOLATION_PAYMENT_RESOURCE, async (id) =>
      StaffViolationView.from(
        await this.tenantTx.withTenantTx(async (tx) => {
          const p = await tx.unitViolationPayment.findUniqueOrThrow({
            where: { id },
          });
          return this.violations.fileOf(
            tx,
            await tx.unitViolation.findUniqueOrThrow({
              where: { id: p.violationId },
            }),
            'staff',
          );
        }),
      ),
    );
  }

  /**
   * Records the payment: open (not a warning, not under appeal), the whole
   * amount, a receipt number (once among the compound's violation
   * payments) and the local day it was paid (not ahead, at most 90 days
   * ago, not before the violation's day).
   */
  record(
    violationId: string,
    input: NewViolationPayment,
  ): Promise<ViolationFile> {
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
      await this.idempotency.claim(tx, {
        type: VIOLATION_PAYMENT_RESOURCE,
        id,
      });
      await this.safety.lockSelf(tx);
      const v = await this.violations.lockRow(tx, violationId);
      if (v.status === 'under_appeal')
        throw appError.conflict(
          ErrorCode.VIOLATION_UNDER_APPEAL,
          'The violation is under appeal: it is paid once decided',
        );
      if (v.status !== 'open' || v.amount === null)
        throw appError.conflict(
          ErrorCode.VIOLATION_NOT_PAYABLE,
          'The violation takes no payment',
          { params: { status: v.amount === null ? 'warning' : v.status } },
        );
      const amount = new Prisma.Decimal(input.amount);
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const today = localDate(await dbNow(tx), timezone);
      const occurred = dayOf(v.occurredOn)!;
      const floor = addDays(today, -PAID_ON_DAYS);
      const min = occurred > floor ? occurred : floor;
      const fields: FieldError[] = [
        ...(amount.equals(v.amount)
          ? []
          : [
              {
                field: 'amount',
                code: FieldErrorCode.AMOUNT_MISMATCH,
                params: { amount: v.amount.toFixed(2) },
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
      await tx.unitViolationPayment.create({
        data: {
          id,
          tenantId: v.tenantId,
          violationId,
          kind: 'payment',
          amount,
          currency: CURRENCY,
          receiptNumber: input.receiptNumber,
          paidOn: asDate(input.paidOn),
          recordedById: this.ctx.accountId,
        },
      });
      const paid = await tx.unitViolation.update({
        where: { id: violationId },
        data: { status: 'paid' },
      });
      await this.audit.record(tx, {
        action: 'violation.payment_recorded',
        targetId: id,
        metadata: {
          violationId,
          unitId: v.unitId,
          amount: amount.toFixed(2),
          currency: CURRENCY,
          receiptNumber: input.receiptNumber,
          paidOn: input.paidOn,
        },
      });
      return this.violations.fileOf(tx, paid, 'staff');
    });
  }

  /** A payment recorded by mistake is reversed, once: open again. */
  reverse(
    paymentId: string,
    reasonCode: string | undefined,
  ): Promise<ViolationFile> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.violationPaymentReverse,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, {
        type: VIOLATION_PAYMENT_RESOURCE,
        id,
      });
      await this.safety.lockSelf(tx);
      const seen = await tx.unitViolationPayment.findUnique({
        where: { id: paymentId },
      });
      if (seen?.kind !== 'payment') throw paymentNotFound();
      const v = await this.violations.lockRow(tx, seen.violationId);
      const already = await tx.unitViolationPayment.findFirst({
        where: { reversesId: paymentId },
        select: { id: true },
      });
      if (already)
        throw appError.conflict(
          ErrorCode.VIOLATION_PAYMENT_ALREADY_REVERSED,
          'This payment was reversed already',
        );
      await tx.unitViolationPayment.create({
        data: {
          id,
          tenantId: v.tenantId,
          violationId: v.id,
          kind: 'reversal',
          reversesId: paymentId,
          reasonCode: reason,
          recordedById: this.ctx.accountId,
        },
      });
      const open = await tx.unitViolation.update({
        where: { id: v.id },
        data: { status: 'open' },
      });
      await this.audit.record(tx, {
        action: 'violation.payment_reversed',
        targetId: id,
        metadata: {
          violationId: v.id,
          unitId: v.unitId,
          reversesId: paymentId,
          reasonCode: reason,
        },
      });
      return this.violations.fileOf(tx, open, 'staff');
    });
  }
}
