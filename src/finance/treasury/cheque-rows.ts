import type { Prisma } from '@prisma/client';
import type { AuditService } from '../../core/audit/audit.service';
import type { LocalDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { asDate } from '../db-clock';
import { show } from '../money';

export interface NewCheque {
  /** Its id, when the caller claimed it for an Idempotency-Key. */
  id?: string;
  tenantId: string;
  unitId: string;
  number: string;
  bankName: string | null;
  amount: Prisma.Decimal;
  dueOn: LocalDate;
  receivedOn: LocalDate;
  recordedById: string;
  /** The payment it made at once (dated the day it was received or earlier); null while post-dated. */
  paymentId: string | null;
}

/**
 * Puts a cheque in the register (ADR 0085), audited, under the unit's
 * finance lock the caller holds. A plain function, so the payments'
 * office path (a payment by cheque) and the register's own receipt share
 * it without importing each other.
 */
export async function registerCheque(
  tx: TenantTxClient,
  audit: AuditService,
  c: NewCheque,
): Promise<string> {
  const id = c.id ?? newId();
  await tx.financeCheque.create({
    data: {
      id,
      tenantId: c.tenantId,
      unitId: c.unitId,
      number: c.number,
      bankName: c.bankName,
      amount: c.amount,
      dueOn: asDate(c.dueOn),
      receivedOn: asDate(c.receivedOn),
      recordedById: c.recordedById,
      paymentId: c.paymentId,
    },
  });
  await audit.record(tx, {
    action: 'cheque.received',
    targetId: id,
    metadata: {
      unitId: c.unitId,
      amount: show(c.amount),
      dueOn: c.dueOn,
      postDated: c.dueOn > c.receivedOn,
      paymentId: c.paymentId,
    },
  });
  return id;
}
