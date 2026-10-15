import type { TenantTxClient } from '../core/database/tenant-tx.service';

export type CounterKind =
  'invoice' | 'credit_note' | 'receipt' | 'instalment_plan' | 'refund';

/**
 * The one order in which a transaction takes numbers (ADR 0048). A counter
 * row stays locked until commit, and two units' transactions are not kept
 * apart by the compound's shared lock: two of them taking two counters in
 * opposite orders would deadlock. Taking a kind that sorts before one this
 * transaction already took is a programming error, refused at once.
 */
export const COUNTER_ORDER: readonly CounterKind[] = [
  'instalment_plan',
  'credit_note',
  'invoice',
  'refund',
  'receipt',
];

const lastTaken = new WeakMap<object, number>();

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
  inOrder(tx, kind);
  const [{ last }] = await tx.$queryRaw<{ last: number }[]>`
    INSERT INTO finance_counters (tenant_id, kind, last_number)
    VALUES (${tenantId}::uuid, ${kind}, ${count})
    ON CONFLICT (tenant_id, kind)
      DO UPDATE SET last_number = finance_counters.last_number + ${count}
    RETURNING last_number AS last`;
  return last - count + 1;
}

/** Throws when `kind` comes before a counter `tx` already took. */
export function inOrder(tx: object, kind: CounterKind): void {
  const rank = COUNTER_ORDER.indexOf(kind);
  const before = lastTaken.get(tx) ?? -1;
  if (rank < before)
    throw new Error(
      `finance counters: ${kind} taken after ${COUNTER_ORDER[before]} (see COUNTER_ORDER)`,
    );
  lastTaken.set(tx, rank);
}

const PREFIX: Record<CounterKind, string> = {
  invoice: 'INV',
  credit_note: 'CN',
  receipt: 'RC',
  instalment_plan: 'IP',
  refund: 'RF',
};

/** `INV-000123`: six digits at least, as the house numbers are. */
export function formatNumber(kind: CounterKind, n: number): string {
  return `${PREFIX[kind]}-${String(n).padStart(6, '0')}`;
}
