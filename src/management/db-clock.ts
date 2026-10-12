import type { TenantTxClient } from '../core/database/tenant-tx.service';

/**
 * The database's clock, now (as maintenance times its visits and SLA, ADR
 * 0034): a request's cycle, its due time and its appointments are timed by
 * one clock, the database's, never by the app server's. Read after the row
 * lock a decision depends on, so a request that waited for the lock is
 * timed when it decides, not when it began. Milliseconds, like the columns.
 */
export async function dbNow(tx: TenantTxClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return now;
}
