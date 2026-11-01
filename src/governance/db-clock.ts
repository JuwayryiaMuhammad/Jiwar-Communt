import type { TenantTxClient } from '../core/database/tenant-tx.service';

/**
 * The database's clock, now: whether a board sits, a vote is open or a
 * window has closed is decided by one clock, the database's (as ADR 0039
 * and 0044 do). Read after the lock a decision depends on.
 */
export async function dbNow(tx: TenantTxClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return now;
}

/** A local day as a `DATE` column stores it (ADR 0075's due days). */
export const asDate = (d: string) => new Date(`${d}T00:00:00.000Z`);

/** A `DATE` column's value as a local day. */
export const fromDate = (d: Date): string => d.toISOString().slice(0, 10);
