import type { TenantTxClient } from '../core/database/tenant-tx.service';

/**
 * The database's clock, now (as management times its requests, ADR 0039):
 * whether a window is too soon, a request has expired, a desk link is still
 * valid or a rating is still open is decided by one clock, the database's,
 * never by the app server's. Read after the lock a decision depends on, so
 * a write that waited for the lock is timed when it decides, not when it
 * began. Milliseconds, like the columns.
 */
export async function dbNow(tx: TenantTxClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return now;
}
