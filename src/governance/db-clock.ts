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
