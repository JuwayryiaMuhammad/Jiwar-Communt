/**
 * The facilities screens' rules (ADR 0044), as the API holds them
 * (src/facilities/setup/facility-rules.ts, settings/defaults.ts). Plain
 * TypeScript with no imports, so the tests run it as is.
 */

export const RULE_RANGES = {
  slotMinutes: { min: 15, max: 480 },
  capacity: { min: 1, max: 500 },
  maxDaysAhead: { min: 1, max: 90 },
  minMinutesBefore: { min: 0, max: 10080 },
  cancelCutoffMinutes: { min: 0, max: 10080 },
  maxGuests: { min: 0, max: 50 },
  weeklyQuota: { min: 1, max: 20 },
  peakQuota: { min: 1, max: 20 },
} as const;
export type RuleField = keyof typeof RULE_RANGES;
export const RULE_FIELDS = Object.keys(RULE_RANGES) as RuleField[];

export const SETTING_RANGES = {
  noShowThreshold: { min: 1, max: 10 },
  noShowWindowDays: { min: 7, max: 90 },
  suspensionDays: { min: 1, max: 90 },
} as const;
export type SettingField = keyof typeof SETTING_RANGES;
export const SETTING_FIELDS = Object.keys(SETTING_RANGES) as SettingField[];

/** A whole number inside the range, as typed in a form. */
export function inRange(range: { min: number; max: number }, value: string): boolean {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return false;
  const n = Number(text);
  return n >= range.min && n <= range.max;
}

/** What the API refuses as PEAK_QUOTA_ABOVE_WEEKLY, said before it is sent. */
export function peakProblem(weekly: string, peak: string): string | undefined {
  if (!inRange(RULE_RANGES.weeklyQuota, weekly) || !inRange(RULE_RANGES.peakQuota, peak)) return undefined;
  return Number(peak) > Number(weekly) ? 'At most the weekly quota.' : undefined;
}

/** The fields of `form` that differ from `saved`, as numbers: only what changed is sent. */
export function numberChanges<K extends string>(
  form: Record<K, string>,
  saved: Record<K, number>,
  fields: readonly K[],
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const f of fields) if (Number(form[f].trim()) !== saved[f]) out[f] = Number(form[f].trim());
  return out;
}

/** "1 h 30 min", "2 days", "0 min": a number of minutes for people. */
export function minutesText(minutes: number): string {
  if (minutes === 0) return 'no notice';
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
}

export interface DaySlot {
  startsAt: string;
  endsAt: string;
  peak: boolean;
  taken: number;
}

export interface DayBooking {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
}

/**
 * A day's grid: each slot of the hours with the bookings that overlap it,
 * and the bookings that fall in no slot of today's hours (made before the
 * hours or the slot length changed) on their own, so none is lost.
 */
export function dayGrid<B extends DayBooking>(
  slots: readonly DaySlot[],
  bookings: readonly B[],
): { rows: { slot: DaySlot; bookings: B[] }[]; outside: B[] } {
  const overlaps = (s: DaySlot, b: B) =>
    new Date(b.startsAt) < new Date(s.endsAt) && new Date(s.startsAt) < new Date(b.endsAt);
  const rows = slots.map((slot) => ({ slot, bookings: bookings.filter((b) => overlaps(slot, b)) }));
  const outside = bookings.filter((b) => !slots.some((s) => overlaps(s, b)));
  return { rows, outside };
}

/** What a handler may do to a booking now, by its status and its time. */
export function bookingActions(
  b: { status: string; startsAt: string; endsAt: string },
  now: Date,
): ('approve' | 'reject' | 'cancel' | 'no_show')[] {
  const started = new Date(b.startsAt) <= now;
  const ended = new Date(b.endsAt) <= now;
  const markable = ended && now.getTime() - new Date(b.endsAt).getTime() <= 72 * 3_600_000;
  if (b.status === 'pending') return started ? [] : ['approve', 'reject', 'cancel'];
  if (b.status === 'confirmed') return ended ? (markable ? ['no_show'] : []) : ['cancel'];
  return [];
}

/** How full a slot is, for the staff: "2 / 4". */
export const takenText = (taken: number, capacity: number) => `${taken} / ${capacity}`;

/** The day `n` days after `date` (`YYYY-MM-DD`). */
export function shiftDay(date: string, n: number): string {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** A local `datetime-local` value (`YYYY-MM-DDTHH:mm`) as an ISO instant, or null. */
export function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** EGP as the API takes it: digits, up to two decimals, more than zero, at most 1,000,000. */
export function validMoney(value: string): boolean {
  const text = value.trim();
  return /^\d{1,7}(\.\d{1,2})?$/.test(text) && Number(text) > 0 && Number(text) <= 1_000_000;
}

/** A receipt number as the API takes it. */
export const validReceipt = (value: string) => /^[A-Za-z0-9/-]{1,40}$/.test(value.trim());
