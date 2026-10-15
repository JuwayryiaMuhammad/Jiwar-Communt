import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';

/**
 * Raw rows of the finance tables (ADR 0046), written straight through the
 * tenant client: for the database-level suites (RLS isolation, schema),
 * which test what the tables refuse whatever the services would do.
 */

const today = () =>
  new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
const sealed = () => Uint8Array.from(randomBytes(40));
let counter = 0;
/** A number no other row of the suite takes. */
const next = () => (Date.now() % 1_000_000_000) + ++counter;

export async function gatewayRow(
  tx: TenantTxClient,
  tenantId: string,
  updatedById: string | null,
): Promise<string> {
  await tx.financeGateway.create({
    data: {
      tenantId,
      mode: 'sandbox',
      keyVersion: 1,
      secretKeyEnc: sealed(),
      publicKeyEnc: sealed(),
      hmacSecretEnc: sealed(),
      cardIntegrationEnc: sealed(),
      secretKeyLast4: 'abcd',
      publicKeyLast4: 'abcd',
      hmacSecretLast4: 'abcd',
      cardIntegrationLast4: '0001',
      updatedById,
      updatedByPlatform: updatedById === null,
    },
  });
  return tenantId;
}

export async function batchRow(
  tx: TenantTxClient,
  r: { tenantId: string; unitId: string; createdById: string },
): Promise<string> {
  const id = newId();
  await tx.invoiceBatch.create({
    data: {
      id,
      tenantId: r.tenantId,
      target: 'unit',
      unitId: r.unitId,
      kind: 'other',
      unitCount: 1,
      issuedOn: today(),
      dueOn: today(),
      createdById: r.createdById,
    },
  });
  return id;
}

/** An invoice and its one line (they must add up at commit). */
export async function invoiceRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    unitId: string;
    batchId: string;
    createdById: string;
    total?: string;
  },
): Promise<string> {
  const id = newId();
  const total = new Prisma.Decimal(r.total ?? '100');
  await tx.invoice.create({
    data: {
      id,
      tenantId: r.tenantId,
      number: next(),
      batchId: r.batchId,
      unitId: r.unitId,
      kind: 'other',
      total,
      currency: 'EGP',
      issuedOn: today(),
      dueOn: today(),
      createdById: r.createdById,
    },
  });
  await lineRow(tx, {
    tenantId: r.tenantId,
    invoiceId: id,
    amount: total.toFixed(2),
  });
  return id;
}

export async function lineRow(
  tx: TenantTxClient,
  r: { tenantId: string; invoiceId: string; amount: string; position?: number },
): Promise<string> {
  const id = newId();
  await tx.invoiceLine.create({
    data: {
      id,
      tenantId: r.tenantId,
      invoiceId: r.invoiceId,
      position: r.position ?? 1,
      descriptionEn: 'Line',
      descriptionAr: 'بند',
      amount: new Prisma.Decimal(r.amount),
    },
  });
  return id;
}

/** An instalment plan over `invoiceId` (one plan per invoice, ever). */
export async function instalmentPlanRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    unitId: string;
    invoiceId: string;
    createdById: string;
  },
): Promise<string> {
  const id = newId();
  await tx.instalmentPlan.create({
    data: {
      id,
      tenantId: r.tenantId,
      number: next(),
      unitId: r.unitId,
      invoiceId: r.invoiceId,
      instalmentCount: 2,
      total: new Prisma.Decimal('100'),
      createdById: r.createdById,
    },
  });
  return id;
}

/** An open dispute of `invoiceId` (one open per invoice). */
export async function disputeRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    unitId: string;
    invoiceId: string;
    openedById: string;
  },
): Promise<string> {
  const id = newId();
  await tx.invoiceDispute.create({
    data: {
      id,
      tenantId: r.tenantId,
      invoiceId: r.invoiceId,
      unitId: r.unitId,
      openedById: r.openedById,
      reasonCode: 'wrong_amount',
      text: 'The amount is wrong',
    },
  });
  return id;
}

export async function creditNoteRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    invoiceId: string;
    createdById: string;
    amount?: string;
  },
): Promise<string> {
  const id = newId();
  await tx.creditNote.create({
    data: {
      id,
      tenantId: r.tenantId,
      number: next(),
      invoiceId: r.invoiceId,
      amount: new Prisma.Decimal(r.amount ?? '1'),
      reasonCode: 'waiver',
      createdById: r.createdById,
    },
  });
  return id;
}

export async function noticeRow(
  tx: TenantTxClient,
  r: { tenantId: string; invoiceId: string },
): Promise<string> {
  const id = newId();
  await tx.invoiceNotice.create({
    data: { id, tenantId: r.tenantId, invoiceId: r.invoiceId, kind: 'issued' },
  });
  return id;
}

export async function planRow(
  tx: TenantTxClient,
  r: { tenantId: string; createdById: string },
): Promise<string> {
  const id = newId();
  await tx.billingPlan.create({
    data: {
      id,
      tenantId: r.tenantId,
      nameEn: 'Plan',
      nameAr: 'خطة',
      kind: 'service_charge',
      frequency: 'monthly',
      amount: new Prisma.Decimal('100'),
      startsOn: new Date('2099-01-01T00:00:00.000Z'),
      issueDaysBefore: 0,
      dueDaysAfterIssue: 10,
      createdById: r.createdById,
    },
  });
  return id;
}

export async function overrideRow(
  tx: TenantTxClient,
  r: { tenantId: string; planId: string; unitId: string; updatedById: string },
): Promise<string> {
  const id = newId();
  await tx.billingPlanOverride.create({
    data: {
      id,
      tenantId: r.tenantId,
      planId: r.planId,
      unitId: r.unitId,
      amount: new Prisma.Decimal('50'),
      excluded: false,
      updatedById: r.updatedById,
    },
  });
  return id;
}

/** An office payment (cash). */
export async function paymentRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    unitId: string;
    recordedById: string;
    amount?: string;
    /** A local day `YYYY-MM-DD`; today in UTC when left out. */
    paidOn?: string;
  },
): Promise<string> {
  const id = newId();
  await tx.financePayment.create({
    data: {
      id,
      tenantId: r.tenantId,
      kind: 'payment',
      unitId: r.unitId,
      channel: 'office',
      method: 'cash',
      amount: new Prisma.Decimal(r.amount ?? '100'),
      currency: 'EGP',
      paidOn: r.paidOn ? new Date(`${r.paidOn}T00:00:00.000Z`) : today(),
      receiptNumber: next(),
      receiptCode: randomBytes(16).toString('base64url'),
      recordedById: r.recordedById,
    },
  });
  return id;
}

/** A refund taking `amount` from one payment's free money. */
export async function refundRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    unitId: string;
    paymentId: string;
    recordedById: string;
    amount?: string;
  },
): Promise<string> {
  const id = newId();
  const amount = new Prisma.Decimal(r.amount ?? '10');
  await tx.financeRefund.create({
    data: {
      id,
      tenantId: r.tenantId,
      kind: 'refund',
      unitId: r.unitId,
      number: next(),
      amount,
      currency: 'EGP',
      channel: 'cash',
      refundedOn: today(),
      recordedById: r.recordedById,
    },
  });
  await tx.financeRefundSource.create({
    data: {
      id: newId(),
      tenantId: r.tenantId,
      refundId: id,
      paymentId: r.paymentId,
      amount,
    },
  });
  return id;
}

export async function allocationRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    paymentId: string;
    invoiceId: string;
    amount?: string;
  },
): Promise<string> {
  const id = newId();
  await tx.financeAllocation.create({
    data: {
      id,
      tenantId: r.tenantId,
      paymentId: r.paymentId,
      invoiceId: r.invoiceId,
      amount: new Prisma.Decimal(r.amount ?? '1'),
    },
  });
  return id;
}

/** An open checkout (status `opening`: nothing from Paymob yet). */
export async function sessionRow(
  tx: TenantTxClient,
  r: { tenantId: string; unitId: string; accountId: string },
): Promise<string> {
  const id = newId();
  await tx.paymentSession.create({
    data: {
      id,
      tenantId: r.tenantId,
      unitId: r.unitId,
      accountId: r.accountId,
      amount: new Prisma.Decimal('100'),
      currency: 'EGP',
      status: 'opening',
      dedupeKey: '0'.repeat(64),
      specialReference: `jw-${id}`,
      expiresAt: new Date(Date.now() + 1_800_000),
    },
  });
  return id;
}

export async function sessionInvoiceRow(
  tx: TenantTxClient,
  r: { tenantId: string; sessionId: string; invoiceId: string },
): Promise<string> {
  const id = newId();
  await tx.paymentSessionInvoice.create({
    data: {
      id,
      tenantId: r.tenantId,
      sessionId: r.sessionId,
      invoiceId: r.invoiceId,
      amount: new Prisma.Decimal('100'),
    },
  });
  return id;
}

export async function eventRow(
  tx: TenantTxClient,
  r: { tenantId: string; sessionId: string | null },
): Promise<string> {
  const id = newId();
  await tx.paymentGatewayEvent.create({
    data: {
      id,
      tenantId: r.tenantId,
      sessionId: r.sessionId,
      gatewayTransactionId: String(next()),
      amountCents: BigInt(10000),
      success: false,
      pending: false,
      outcome: 'failed_attempt',
    },
  });
  return id;
}
