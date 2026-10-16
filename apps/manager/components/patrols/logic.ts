/**
 * The patrol pages (ADR 0052): plain helpers, no imports, so the tests run
 * them as they are.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "Mon, Wed at 08:00, 22:00"; "Unscheduled" without one. */
export function patrolScheduleText(s: { days: number[]; times: string[] } | null | undefined): string {
  if (!s) return 'Unscheduled';
  const days = [...s.days].sort((a, b) => a - b).map((d) => WEEKDAYS[d] ?? '?');
  const every = days.length === 7 ? 'Every day' : days.join(', ');
  return `${every} at ${[...s.times].sort().join(', ')}`;
}

/**
 * The start times typed in the form ("08:00, 14:00 22:00"), sorted, each
 * once; null when one is not `HH:MM`.
 */
export function timesFrom(input: string): string[] | null {
  const parts = input
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!parts.length || parts.some((t) => !TIME.test(t))) return null;
  return [...new Set(parts)].sort();
}

/** A position from the form: both numbers in range, or none (empty). */
export function positionFrom(
  lat: string,
  lng: string,
  radius: string,
): { lat: number; lng: number; radiusM?: number } | null | 'invalid' {
  if (!lat.trim() && !lng.trim()) return null;
  const a = Number(lat);
  const b = Number(lng);
  if (!lat.trim() || !lng.trim() || Number.isNaN(a) || Number.isNaN(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return 'invalid';
  const r = radius.trim() ? Number(radius) : undefined;
  if (r !== undefined && (!Number.isInteger(r) || r < 5 || r > 500)) return 'invalid';
  return r === undefined ? { lat: a, lng: b } : { lat: a, lng: b, radiusM: r };
}

/** "3 / 5", the scans of a run. */
export function progressText(run: { scannedCount: number; checkpointsTotal: number }): string {
  return `${run.scannedCount} / ${run.checkpointsTotal}`;
}

/** Moves the item at `index` one place up (-1) or down (+1). */
export function moved<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (to < 0 || to >= list.length) return [...list];
  const out = [...list];
  [out[index], out[to]] = [out[to] as T, out[index] as T];
  return out;
}
