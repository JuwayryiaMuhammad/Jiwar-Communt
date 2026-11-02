import { FieldErrorCode } from '../common/errors';
import { invalid } from '../common/localized';
import {
  addDays,
  localDate,
  zonedInstant,
  type LocalDate,
} from '../common/slots/day-slots';
import type { TenantTxClient } from '../database/tenant-tx.service';
import type { TenantSettingsService } from '../tenant-settings/tenant-settings.service';
import { clock } from './experience-locks';

/** The longest period a report covers, in days. */
export const REPORT_MAX_DAYS = 366;
const DEFAULT_DAYS = 30;

export interface Period {
  from: LocalDate;
  to: LocalDate;
  /** The compound's midnight starting `from`, and the one after `to`. */
  start: Date;
  end: Date;
}

/**
 * A report's days by the compound's clock (ADR 0025): `to` today and `from`
 * 30 days before it by default; at most 366 days.
 */
export async function periodOf(
  tx: TenantTxClient,
  settings: TenantSettingsService,
  tenantId: string,
  q: { from?: LocalDate; to?: LocalDate },
): Promise<Period> {
  const { timezone } = await settings.inTx(tx, tenantId);
  const to = q.to ?? localDate(await clock(tx), timezone);
  const from = q.from ?? addDays(to, -(DEFAULT_DAYS - 1));
  if (to < from)
    throw invalid([{ field: 'to', code: FieldErrorCode.ENDS_BEFORE_START }]);
  if (to > addDays(from, REPORT_MAX_DAYS - 1))
    throw invalid([
      {
        field: 'to',
        code: FieldErrorCode.PERIOD_TOO_LONG,
        params: { maxDays: REPORT_MAX_DAYS },
      },
    ]);
  return {
    from,
    to,
    start: midnight(from, timezone),
    end: midnight(addDays(to, 1), timezone),
  };
}

/** The day's first instant; a midnight lost to a clock change is 01:00. */
function midnight(day: LocalDate, timezone: string): Date {
  return zonedInstant(day, 0, timezone) ?? zonedInstant(day, 60, timezone)!;
}
