// ============================================================================
// A unit's quota at a facility (ADR 0044)
// ============================================================================
//
// Any 7 consecutive days hold at most `quota` of the unit's counted
// bookings at a facility (pending, confirmed, no-show; past ones too). A new
// booking is allowed when every 7-day window that would contain its start
// stays within the quota. Pure: the service feeds it what it read under the
// unit's lock.

export const WEEK_MS = 7 * 86_400_000;

/**
 * The most bookings any 7-day window containing `start` holds, counting
 * the new one. The windows are `[s, s + 7 days)` with `s` in
 * `(start − 7 days, start]`; the fullest begins at `start` or at one of the
 * starts already held.
 */
export function busiestWeek(held: readonly Date[], start: Date): number {
  const t = start.getTime();
  const starts = held.map((d) => d.getTime());
  const candidates = [t, ...starts.filter((s) => s > t - WEEK_MS && s <= t)];
  let most = 0;
  for (const from of candidates) {
    const inWindow = starts.filter((s) => s >= from && s < from + WEEK_MS);
    most = Math.max(most, inWindow.length + 1);
  }
  return most;
}

/** Whether a booking starting at `start` keeps every week within `quota`. */
export const withinQuota = (
  held: readonly Date[],
  start: Date,
  quota: number,
) => busiestWeek(held, start) <= quota;
