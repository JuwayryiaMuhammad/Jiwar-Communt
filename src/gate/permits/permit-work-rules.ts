import { lockCalendar, worksDaysOff } from '../../core/holidays/holiday-reads';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { workRules, type WorkRules } from './permit-rules';

/**
 * The compound's work rules as every permit path reads them (ADR 0049):
 * the week days and hours of permit_settings, and the days off — the
 * holidays that stop works on the compound's calendar (ADR 0084). With
 * `share`, a decision locks permit_settings' row and then the calendar's
 * FOR SHARE (the permits' lock order: the unit, the rules, the calendar,
 * the permit), so a change of either waits for it.
 */
export async function readWorkRules(
  tx: TenantTxClient,
  tenantId: string,
  lock: 'share' | 'none' = 'none',
): Promise<WorkRules> {
  if (lock === 'share') {
    await tx.$queryRaw`
      SELECT tenant_id FROM permit_settings
       WHERE tenant_id = ${tenantId}::uuid FOR SHARE`;
    await lockCalendar(tx, tenantId, 'share');
  }
  return workRules(
    await tx.permitSettings.findUniqueOrThrow({ where: { tenantId } }),
    await worksDaysOff(tx),
  );
}
