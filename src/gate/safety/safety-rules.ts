/**
 * What emergencies and gate service requests share (ADR 0047): their
 * references, the minutes a responder may pick, and the countdown shown
 * from them. Pure; unit-tested.
 */

/** E- for emergencies, A- for accessibility help, S- for the other services. */
export type SafetyPrefix = 'E' | 'A' | 'S';

/** `E-0042`: the compound's own numbers, as everywhere (ADR 0008). */
export function safetyReference(prefix: SafetyPrefix, n: number): string {
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

/** No GPS (ADR 0047): the responder picks how far they are. */
export const ETA_MINUTES = [2, 5, 10, 15] as const;
export type EtaMinutes = (typeof ETA_MINUTES)[number];

const MINUTE = 60_000;

/**
 * Minutes until the responder is there, counted down from the time they
 * accepted: null before anyone accepted and once closed, 0 once arrived,
 * never below 0 (late is "any moment now", not negative).
 */
export function minutesAway(
  r: {
    status: string;
    etaMinutes: number | null;
    acceptedAt: Date | null;
    arrivedAt: Date | null;
  },
  now: Date,
): number | null {
  if (r.arrivedAt) return r.status === 'arrived' ? 0 : null;
  if (!r.acceptedAt || r.etaMinutes === null) return null;
  if (!['on_the_way', 'accepted', 'in_progress'].includes(r.status))
    return null;
  const left = r.etaMinutes - (now.getTime() - r.acceptedAt.getTime()) / MINUTE;
  return Math.max(0, Math.ceil(left));
}
