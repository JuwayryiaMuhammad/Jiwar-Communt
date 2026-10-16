/**
 * Pure helpers of the permits pages (ADR 0049): the words the dashboard
 * uses for a permit's kind and period, and the checks of the rules form.
 */

export const PERMIT_KIND_TEXT = {
  works: 'Works',
  move: 'Furniture move',
  material_exit: 'Materials out',
  event: 'Event',
} as const satisfies Record<'works' | 'move' | 'material_exit' | 'event', string>;

/** 0 = Sunday … 6 = Saturday, as the API counts them. */
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** `HH:mm`, 00:00 to 23:59. */
export function validTime(value: string): boolean {
  return TIME.test(value);
}

/** Hours that end after they start, both well formed. */
export function validHours(from: string, to: string): boolean {
  return validTime(from) && validTime(to) && to > from;
}

/** Work days sorted, each once; at least one. */
export function toggleDay(days: readonly number[], day: number): number[] {
  const set = new Set(days);
  if (set.has(day)) set.delete(day);
  else set.add(day);
  return [...set].sort((a, b) => a - b);
}

/** "Sun–Thu, Sat" style: the work days, short. */
export function describeDays(days: readonly number[]): string {
  if (days.length === 7) return 'Every day';
  return days.map((d) => WEEKDAYS[d]).join(', ');
}

/** A day off added once, in order; a malformed date is refused (null). */
export function addDayOff(daysOff: readonly string[], date: string): string[] | null {
  if (!DATE.test(date)) return null;
  return [...new Set([...daysOff, date])].sort();
}

/** What a permit covers, in one line: its days, or its window (`at` formats an instant). */
export function periodText(
  p: {
  kind: string;
  works?: { startsOn: string; endsOn: string; dailyHours: { from: string; to: string } } | null;
  move?: { date: string; window: { from: string; to: string } } | null;
  materialExit?: { validFrom: string; validUntil: string } | null;
  startsAt: string;
  endsAt: string;
  },
  at: (iso: string) => string,
): string {
  if (p.works) {
    const days = p.works.startsOn === p.works.endsOn ? p.works.startsOn : `${p.works.startsOn} → ${p.works.endsOn}`;
    return `${days}, ${p.works.dailyHours.from}–${p.works.dailyHours.to}`;
  }
  if (p.move) return `${p.move.date}, ${p.move.window.from}–${p.move.window.to}`;
  if (p.materialExit)
    return p.materialExit.validFrom === p.materialExit.validUntil
      ? p.materialExit.validFrom
      : `${p.materialExit.validFrom} → ${p.materialExit.validUntil}`;
  return `${at(p.startsAt)} → ${at(p.endsAt)}`;
}
