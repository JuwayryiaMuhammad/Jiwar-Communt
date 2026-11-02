import { createHash, randomBytes, randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { day as localDay, dbDate } from './compound-clock';

// ============================================================================
// Treasury rows written straight to the database (ADR 0085), for the RLS
// suite and compound B of the API suites. Each is whole: what a deferred
// check counts at commit (a hand-in's items) is written with it.
// ============================================================================

/** The compound's day today, as a `@db.Date`. */
const day = () => dbDate(localDay(0));

export async function cashAccountRow(
  tx: TenantTxClient,
  r: { tenantId: string; createdById: string; kind?: 'bank' | 'cash' },
): Promise<string> {
  const id = newId();
  await tx.financeCashAccount.create({
    data: {
      id,
      tenantId: r.tenantId,
      kind: r.kind ?? 'bank',
      name: `Account ${id.slice(-8)}`,
      openedOn: day(),
      createdById: r.createdById,
    },
  });
  return id;
}

export async function openingRow(
  tx: TenantTxClient,
  r: { tenantId: string; accountId: string; recordedById: string },
): Promise<string> {
  const id = newId();
  await tx.financeCashMovement.create({
    data: {
      id,
      tenantId: r.tenantId,
      accountId: r.accountId,
      kind: 'opening',
      amount: new Prisma.Decimal('500'),
      onDay: day(),
      recordedById: r.recordedById,
    },
  });
  return id;
}

/** A balanced hand-in of one cash payment, with its item. */
export async function handinRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    custodianId: string;
    receivedById: string;
    cashAccountId: string;
    paymentId: string;
    amount?: string;
  },
): Promise<string> {
  const id = newId();
  const amount = new Prisma.Decimal(r.amount ?? '100');
  await tx.financeCustodyHandin.create({
    data: {
      id,
      tenantId: r.tenantId,
      number: randomInt(1, 2_000_000_000),
      custodianId: r.custodianId,
      receivedById: r.receivedById,
      cashAccountId: r.cashAccountId,
      expected: amount,
      counted: amount.sub(1),
      variance: new Prisma.Decimal(-1),
      varianceReason: 'missing_cash',
      paymentCount: 1,
      receivedOn: day(),
      createdAt: new Date(),
      status: 'variance',
    },
  });
  await tx.financeCustodyHandinItem.create({
    data: {
      tenantId: r.tenantId,
      paymentId: r.paymentId,
      handinId: id,
      amount,
    },
  });
  return id;
}

export async function investigationRow(
  tx: TenantTxClient,
  r: { tenantId: string; handinId: string; ownerId: string },
): Promise<string> {
  const id = newId();
  await tx.financeCustodyInvestigation.create({
    data: {
      id,
      tenantId: r.tenantId,
      handinId: r.handinId,
      ownerId: r.ownerId,
      dueOn: day(),
      openedById: r.ownerId,
      openedAt: new Date(),
      status: 'open',
    },
  });
  return id;
}

/** A post-dated cheque held in the register: no payment yet. */
export async function chequeRow(
  tx: TenantTxClient,
  r: { tenantId: string; unitId: string; recordedById: string },
): Promise<string> {
  const id = newId();
  const ahead = dbDate(localDay(30));
  await tx.financeCheque.create({
    data: {
      id,
      tenantId: r.tenantId,
      unitId: r.unitId,
      number: `CHQ${randomInt(100000, 999999)}`,
      amount: new Prisma.Decimal('250'),
      dueOn: ahead,
      receivedOn: day(),
      recordedById: r.recordedById,
    },
  });
  return id;
}

/** An applied statement import with no file left. */
export async function statementImportRow(
  tx: TenantTxClient,
  r: { tenantId: string; accountId: string; createdById: string },
): Promise<string> {
  const id = newId();
  await tx.financeStatementImport.create({
    data: {
      id,
      tenantId: r.tenantId,
      accountId: r.accountId,
      status: 'applied',
      rowCount: 1,
      newCount: 1,
      duplicateCount: 0,
      errorCount: 0,
      createdById: r.createdById,
      createdAt: new Date(),
      appliedAt: new Date(),
      appliedById: r.createdById,
      importedCount: 1,
      matchedCount: 0,
    },
  });
  return id;
}

export async function statementLineRow(
  tx: TenantTxClient,
  r: { tenantId: string; accountId: string; importId: string },
): Promise<string> {
  const id = newId();
  await tx.financeStatementLine.create({
    data: {
      id,
      tenantId: r.tenantId,
      accountId: r.accountId,
      importId: r.importId,
      lineNo: 2,
      bookedOn: day(),
      amount: new Prisma.Decimal('-15'),
      reference: 'FEE',
      lineHash: createHash('sha256').update(randomBytes(16)).digest('hex'),
    },
  });
  return id;
}

/** A line matched as a bank charge (no movement: the suites only read it). */
export async function matchRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    lineId: string;
    accountId: string;
    matchedById: string;
  },
): Promise<string> {
  const id = newId();
  await tx.financeStatementMatch.create({
    data: {
      id,
      tenantId: r.tenantId,
      lineId: r.lineId,
      accountId: r.accountId,
      kind: 'adjustment',
      reasonCode: 'bank_charge',
      auto: false,
      matchedById: r.matchedById,
      matchedAt: new Date(),
    },
  });
  return id;
}
