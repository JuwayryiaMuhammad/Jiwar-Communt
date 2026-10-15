import type { TenantTxClient } from '../core/database/tenant-tx.service';

export type CounterKind = 'invoice' | 'credit_note' | 'receipt';

/**
 * Takes `count` consecutive numbers of `kind` in the compound and returns
 * the first (ADR 0008, 0046). The counter row's lock serialises takers and
 * a rollback gives the numbers back, so numbers are gapless.
 */
export async function takeNumbers(
  tx: TenantTxClient,
  tenantId: string,
  kind: CounterKind,
  count = 1,
): Promise<number> {
  const [{ last }] = await tx.$queryRaw<{ last: number }[]>`
    INSERT INTO finance_counters (tenant_id, kind, last_number)
    VALUES (${tenantId}::uuid, ${kind}, ${count})
    ON CONFLICT (tenant_id, kind)
      DO UPDATE SET last_number = finance_counters.last_number + ${count}
    RETURNING last_number AS last`;
  return last - count + 1;
}

const PREFIX: Record<CounterKind, string> = {
  invoice: 'INV',
  credit_note: 'CN',
  receipt: 'RC',
};

/** `INV-000123`: six digits at least, as the house numbers are. */
export function formatNumber(kind: CounterKind, n: number): string {
  return `${PREFIX[kind]}-${String(n).padStart(6, '0')}`;
}
