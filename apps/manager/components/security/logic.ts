/**
 * The guards' duty pages (ADR 0050): plain helpers. They import only the
 * layer's core and their catalog, by relative path, so the tests run them
 * as they are.
 */
import { createFormat, translator, type Locale } from '@jiwar/i18n/core';
import ar from '../../messages/ar/guard-common.ts';
import en from '../../messages/en/guard-common.ts';

/** The English short weekdays, 0 = Sunday. A page shows `fmt.weekday(n, 'short')`. */
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** The guards' shared words in a language, for the helpers here and in ops-logic. */
export const guardWords = (locale: Locale) => translator(locale, en, ar);

/** The separator of a short list of words or times: `, ` or `، `. */
export const listSep = (locale: Locale) => (locale === 'ar' ? '، ' : ', ');

type PostLike = { gateName?: string | null; zone?: { nameEn: string; nameAr?: string | null } | null } | null | undefined;

/** A gate's name or a zone's English name. */
export function postName(post: PostLike): string {
  return postNameIn(post, 'en');
}

/** A gate's name, or a zone's name in the page's language. */
export function postNameIn(post: PostLike, locale: Locale): string {
  if (!post) return '—';
  return post.gateName ?? (locale === 'ar' ? post.zone?.nameAr || post.zone?.nameEn : post.zone?.nameEn) ?? '—';
}

/** A checkpoint's, a route's or a place's name in the page's language. */
export function nameIn(x: { nameEn: string; nameAr?: string | null } | null | undefined, locale: Locale): string {
  if (!x) return '—';
  return (locale === 'ar' ? x.nameAr || x.nameEn : x.nameEn) || '—';
}

type PersonLike = { fullName?: string | null; erased?: boolean } | null | undefined;

/** A person as an AccountRefView carries them. */
export function personName(ref: PersonLike): string {
  return personNameIn(ref, 'en');
}

/** A person, or the erased shape in the page's language. */
export function personNameIn(ref: PersonLike, locale: Locale): string {
  if (!ref) return '—';
  if (ref.erased) return guardWords(locale)('erased');
  return ref.fullName ?? '—';
}

/** "Sun, Thu 22:00–06:00 (overnight)". */
export function scheduleText(s: { days: number[]; windows: { from: string; to: string }[] }, locale: Locale = 'en'): string {
  const t = guardWords(locale);
  const fmt = createFormat(locale);
  const sep = listSep(locale);
  const days = [...s.days]
    .sort((a, b) => a - b)
    .map((d) => (d >= 0 && d <= 6 ? fmt.weekday(d, 'short') : '?'))
    .join(sep);
  const windows = s.windows
    .map((w) => {
      const window = `${w.from}–${w.to}`;
      return w.to <= w.from ? t('overnight', { window }) : window;
    })
    .join(sep);
  return `${days} ${windows}`.trim();
}

/** "1 h 30 min", "45 min", "0 min". */
export function minutesText(minutes: number | null | undefined, locale: Locale = 'en'): string {
  if (minutes === null || minutes === undefined) return '—';
  const t = guardWords(locale);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return t('minutes', { m });
  return m ? t('hoursMinutes', { h, m }) : t('hours', { h });
}

/** A local `YYYY-MM-DD` moved by `n` days. */
export function addDays(date: string, n: number): string {
  const [y = 1970, m = 1, d = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Today in the browser's time zone, `YYYY-MM-DD`. */
export function today(): string {
  return new Date().toLocaleDateString('en-CA');
}

/**
 * A weekly schedule from the form: the ticked weekdays and one window.
 * Null when it is not one yet (no day, or a time missing or equal).
 */
export function scheduleFrom(days: readonly number[], from: string, to: string): { days: number[]; windows: { from: string; to: string }[] } | null {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!days.length || !time.test(from) || !time.test(to) || from === to) return null;
  return { days: [...new Set(days)].sort((a, b) => a - b), windows: [{ from, to }] };
}

/** `datetime-local` value plus minutes, as an ISO instant (the API's shape). */
export function instantOf(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** A post the forms send: a gate or a zone, by the picker's value. */
export function postBody(value: string): { gateId: string } | { zoneId: string } | null {
  const [type, id] = value.split(':');
  if (!id) return null;
  return type === 'gate' ? { gateId: id } : type === 'zone' ? { zoneId: id } : null;
}
