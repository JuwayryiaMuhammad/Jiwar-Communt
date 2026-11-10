/**
 * Pure helpers of the permits pages (ADR 0049): a permit's kinds and period,
 * and the checks of the rules form. The words are in the permits catalog
 * (`messages/{en,ar}/places-permits.ts`); the helpers that show text take its
 * `t` and the page's `fmt`.
 */
import type { Format, Translate } from '@jiwar/i18n/core';
import type en from '../../messages/en/places-permits.ts';

/** The kinds a unit permit has, in the order the filter shows them (catalog keys `kind.<kind>`). */
export const PERMIT_KINDS = ['works', 'move', 'material_exit', 'event'] as const;

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

/** "Sun, Thu, Sat" style: the work days, short, in the page's language. */
export function describeDays(days: readonly number[], fmt: Format, t: Translate<typeof en>): string {
  if (days.length === 7) return t('everyDay');
  return days.map((d) => fmt.weekday(d, 'short')).join(fmt.locale === 'ar' ? '، ' : ', ');
}

/** A day off added once, in order; a malformed date is refused (null). */
export function addDayOff(daysOff: readonly string[], date: string): string[] | null {
  if (!DATE.test(date)) return null;
  return [...new Set([...daysOff, date])].sort();
}

/** What a permit covers, in one line: its days and hours, or its window. */
export function periodText(
  p: {
    kind: string;
    works?: { startsOn: string; endsOn: string; dailyHours: { from: string; to: string } } | null;
    move?: { date: string; window: { from: string; to: string } } | null;
    materialExit?: { validFrom: string; validUntil: string } | null;
    startsAt: string;
    endsAt: string;
  },
  fmt: Format,
  t: Translate<typeof en>,
): string {
  const days = (from: string, to: string) => (from === to ? fmt.day(from) : t('period.range', { from: fmt.day(from), to: fmt.day(to) }));
  if (p.works)
    return t('period.hours', { days: days(p.works.startsOn, p.works.endsOn), from: p.works.dailyHours.from, to: p.works.dailyHours.to });
  if (p.move) return t('period.hours', { days: fmt.day(p.move.date), from: p.move.window.from, to: p.move.window.to });
  if (p.materialExit) return days(p.materialExit.validFrom, p.materialExit.validUntil);
  return t('period.range', { from: fmt.dateTime(p.startsAt), to: fmt.dateTime(p.endsAt) });
}
