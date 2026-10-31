import type { TenantTxClient } from '../core/database/tenant-tx.service';

/** How busy a gate is (ADR 0071): a level, never a count. */
export type GateBusyLevel = 'quiet' | 'normal' | 'busy';
export const GATE_BUSY_LEVELS: readonly GateBusyLevel[] = [
  'quiet',
  'normal',
  'busy',
];
/** The window the level counts entries over. */
export const GATE_BUSY_WINDOW_MS = 15 * 60_000;

/**
 * Each gate's level now: the entries it logged in the last fifteen minutes
 * against the compound's thresholds. Residents' own entries are never
 * logged (ADR 0031): these are visitors, workers and the like.
 */
export async function gateBusyLevels(
  tx: TenantTxClient,
  tenantId: string,
): Promise<Map<string, GateBusyLevel>> {
  const settings = await tx.gateSettings.findUnique({
    where: { tenantId },
    select: { gateBusyNormalFrom: true, gateBusyBusyFrom: true },
  });
  const normalFrom = settings?.gateBusyNormalFrom ?? 10;
  const busyFrom = settings?.gateBusyBusyFrom ?? 30;
  const rows = await tx.$queryRaw<{ gate_id: string; n: number }[]>`
    SELECT gate_id, count(*)::int AS n
      FROM gate_entries
     WHERE occurred_at > clock_timestamp() - ${GATE_BUSY_WINDOW_MS / 1000} * interval '1 second'
     GROUP BY gate_id`;
  return new Map(
    rows.map((r) => [
      r.gate_id,
      r.n >= busyFrom ? 'busy' : r.n >= normalFrom ? 'normal' : 'quiet',
    ]),
  );
}
