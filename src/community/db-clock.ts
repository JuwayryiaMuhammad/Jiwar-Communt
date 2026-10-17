import type { TenantTxClient } from '../core/database/tenant-tx.service';

/**
 * The database's clock, now (as the other domains read it): a household's
 * "today", against which a member comes of age, is the compound's day by
 * one clock, the database's, never the app server's. Milliseconds, like
 * the columns.
 */
export async function dbNow(tx: TenantTxClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return now;
}
