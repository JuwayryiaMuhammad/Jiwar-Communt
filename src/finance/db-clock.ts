import { localDate, type LocalDate } from '../core/common/slots/day-slots';
import type { TenantTxClient } from '../core/database/tenant-tx.service';

/**
 * The database's clock, now: whether an invoice is due, overdue or a
 * checkout has expired is decided by one clock, the database's (as
 * ADR 0039 and 0044 do). Read after the lock a decision depends on.
 */
export async function dbNow(tx: TenantTxClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return now;
}

/** The compound's local day now. */
export async function localToday(
  tx: TenantTxClient,
  timeZone: string,
): Promise<LocalDate> {
  return localDate(await dbNow(tx), timeZone);
}

/** A local day as the `DATE` column stores it. */
export const asDate = (d: LocalDate) => new Date(`${d}T00:00:00.000Z`);

/** A `DATE` column's value as a local day. */
export const fromDate = (d: Date): LocalDate => d.toISOString().slice(0, 10);
