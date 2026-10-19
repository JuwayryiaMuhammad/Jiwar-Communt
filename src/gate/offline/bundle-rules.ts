// ============================================================================
// The gate bundle's rules (ADR 0057), pure: how long one is valid.
// ============================================================================

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A bundle lives a day at most, whatever its shift says. */
export const BUNDLE_MAX_MS = 24 * HOUR;
/** Past the roster slot's planned end, for a handover that runs late. */
export const SLOT_GRACE_MS = 30 * MINUTE;
/** A shift that filled no roster slot has no planned end. */
export const UNSCHEDULED_MS = 12 * HOUR;
/** A shift past its slot's planned end (overtime): a short bundle. */
export const OVERTIME_MS = HOUR;

/**
 * Until when a bundle issued at `issuedAt` decides anything (ADR 0057): the
 * shift's planned end (its roster slot's end, plus half an hour), a day at
 * most. A shift with no slot gets twelve hours; one already past its
 * slot's end (overtime) one hour, renewed while it is online.
 */
export function bundleValidUntil(
  issuedAt: Date,
  slotEndsAt: Date | null,
): Date {
  const at = issuedAt.getTime();
  if (slotEndsAt === null) return new Date(at + UNSCHEDULED_MS);
  const planned = slotEndsAt.getTime() + SLOT_GRACE_MS;
  if (planned <= at) return new Date(at + OVERTIME_MS);
  return new Date(Math.min(planned, at + BUNDLE_MAX_MS));
}
