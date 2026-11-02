import type { FinanceCashAccount } from '@prisma/client';
import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * The treasury's locks (ADR 0085), after the finance locks of ADR 0046
 * and always in this order:
 *
 * 1. the caller's account, shared (FinanceAccess.lockSelf);
 * 2. units' finance locks (a cheque's or a payment's unit);
 * 3. a cheque, a hand-in or an investigation row, FOR UPDATE;
 * 4. a custodian's custody lock (a two-key advisory lock of its own);
 * 5. bank and cash accounts, FOR UPDATE, in id order;
 * 6. a statement import, a line's matches.
 *
 * A payment path holds 1–2 and takes 4 before it writes an office cash
 * payment or its reversal, so a hand-in that holds 4 sees every payment
 * of its custodian committed before it, and none after. A vendor's payout
 * (ADR 0089) takes 5 after its payables' rows and budget lines, and before
 * its counters, as a hand-in takes its cash box before its number.
 */
export async function lockCustody(
  tx: TenantTxClient,
  tenantId: string,
  custodianId: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${`finance-custody:${tenantId}`}), hashtext(${custodianId}))`;
}

export const accountNotFound = () =>
  appError.notFound(
    ErrorCode.CASH_ACCOUNT_NOT_FOUND,
    'Bank or cash account not found',
  );

/**
 * Accounts FOR UPDATE in id order, every one of them found; a retired
 * one refused when `live`, one of another kind when `kind` is given.
 */
export async function lockAccounts(
  tx: TenantTxClient,
  ids: readonly string[],
  opts: { live?: boolean; kind?: 'bank' | 'cash' } = {},
): Promise<Map<string, FinanceCashAccount>> {
  const sorted = [...new Set(ids)].sort();
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM finance_cash_accounts WHERE id = ANY(${sorted}::uuid[])
     ORDER BY id FOR UPDATE`;
  if (locked.length !== sorted.length) throw accountNotFound();
  const rows = await tx.financeCashAccount.findMany({
    where: { id: { in: sorted } },
  });
  for (const a of rows) {
    if (opts.live && a.retiredAt)
      throw appError.conflict(
        ErrorCode.CASH_ACCOUNT_RETIRED,
        'The account is retired',
      );
    if (opts.kind && a.kind !== opts.kind)
      throw appError.conflict(
        ErrorCode.CASH_ACCOUNT_WRONG_KIND,
        'Not the kind of account this needs',
        { params: { kind: opts.kind } },
      );
  }
  return new Map(rows.map((a) => [a.id, a]));
}
