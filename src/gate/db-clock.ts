import type { TenantTxClient } from '../core/database/tenant-tx.service';

/**
 * The database's clock, now (as the facilities time their bookings, ADR
 * 0044): whether a permit has expired, a booking window has passed or an
 * appeal is late is decided by one clock, the database's. Read after the
 * lock a decision depends on. Milliseconds, like the columns.
 */
export async function dbNow(tx: TenantTxClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return now;
}
