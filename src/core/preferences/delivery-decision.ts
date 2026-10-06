import type {
  DeliveryChannel,
  DeliveryClass,
  NotificationCategory,
} from './categories';
import {
  addLocalDays,
  localParts,
  parseTime,
  zonedInstant,
} from './zoned-time';

/**
 * An account's delivery preferences as deliveryDecision reads them
 * (ADR 0036). Defaults: every category and channel on, no quiet hours, no
 * pause.
 */
export interface DeliveryPrefs {
  /** The compound's time zone (`tenant_settings.timezone`). */
  timeZone: string;
  /** Category × channel switches; a missing entry is on. */
  channels: Partial<
    Record<NotificationCategory, Partial<Record<DeliveryChannel, boolean>>>
  >;
  /** Local `HH:MM`; the window runs past midnight when end < start. */
  quietHours: { start: string; end: string } | null;
  /** `until: null` is "until turned back on". */
  pause: { until: Date | null } | null;
}

export const DEFAULT_PREFS = (timeZone: string): DeliveryPrefs => ({
  timeZone,
  channels: {},
  quietHours: null,
  pause: null,
});

export type DeliveryDecision =
  | { action: 'deliver' }
  /** `until: null`: until the account turns its pause off. */
  | { action: 'hold'; until: Date | null }
  | { action: 'skip' };

const DELIVER: DeliveryDecision = { action: 'deliver' };

/**
 * Whether a delivery goes now, waits, or does not go (ADR 0036):
 *
 * 1. a critical kind always goes, now;
 * 2. a category × channel turned off skips it, unless the email is the
 *    notice's only record (`soleRecord`), which is never skipped;
 * 3. a pause holds it until the pause ends: a timed pause (1 h, 8 h) holds
 *    everything, a pause "until resumed" holds all but soleRecord emails;
 * 4. quiet hours hold it until the window ends, also when a pause ends
 *    inside one.
 *
 * Held, never dropped: a held delivery goes when the hold ends.
 */
export function deliveryDecision(
  prefs: DeliveryPrefs,
  klass: DeliveryClass,
  channel: DeliveryChannel,
  now: Date,
): DeliveryDecision {
  if (klass.critical) return DELIVER;
  const enabled = prefs.channels[klass.category]?.[channel] ?? true;
  if (!enabled && !klass.soleRecord) return { action: 'skip' };

  let t = now;
  if (prefs.pause) {
    const { until } = prefs.pause;
    if (until === null) {
      if (!klass.soleRecord) return { action: 'hold', until: null };
    } else if (until > t) {
      t = until;
    }
  }
  if (prefs.quietHours) {
    const end = quietEnd(prefs.quietHours, prefs.timeZone, t);
    if (end) t = end;
  }
  return t > now ? { action: 'hold', until: t } : DELIVER;
}

/** When the quiet window `at` falls in ends; null when it is outside one. */
export function quietEnd(
  window: { start: string; end: string },
  timeZone: string,
  at: Date,
): Date | null {
  const start = parseTime(window.start);
  const end = parseTime(window.end);
  if (start === null || end === null || start === end) return null;
  const local = localParts(at, timeZone);
  const m = local.hour * 60 + local.minute;
  const inside = start < end ? m >= start && m < end : m >= start || m < end;
  if (!inside) return null;
  // Before the end on the same local day, or (past midnight) the next one.
  const day = m < end ? local : addLocalDays(local, 1);
  return zonedInstant(day, end, timeZone);
}
