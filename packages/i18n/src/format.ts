import { intlLocale, type Locale } from './locale.ts';

/**
 * Every date, number and amount a page shows goes through one of these, so
 * the two languages format alike (Western digits, see `intlLocale`).
 *
 * Times are shown in the browser's time zone, the compound's in practice, as
 * the dashboards always did; pass `timeZone` where the compound's zone is
 * known (the public pages get it from the API). A plain day (`2026-11-10`, a
 * date without a time) is shown as that day wherever the browser is.
 */
export type DateInput = string | number | Date | null | undefined;

export interface Format {
  readonly locale: Locale;
  /** `10 Nov 2026` · `10 نوفمبر 2026` */
  date(value: DateInput): string;
  /** `10 Nov 2026, 14:05` · `10 نوفمبر 2026، 2:05 م` */
  dateTime(value: DateInput): string;
  /** `14:05` · `2:05 م` */
  time(value: DateInput): string;
  /** A plain `YYYY-MM-DD` day (or `YYYY-MM` month), never shifted by the time zone. */
  day(value: string | null | undefined): string;
  /** `November 2026` from `2026-11` or `2026-11-01`. */
  month(value: string | null | undefined): string;
  /** `Tue` · `الثلاثاء` from a weekday number, 0 = Sunday. */
  weekday(day: number, width?: 'short' | 'long'): string;
  /** Any other shape of date, formatted in this language. */
  custom(value: DateInput, options: Intl.DateTimeFormatOptions): string;
  /** `3 hours ago` · `منذ 3 ساعات` */
  relative(value: DateInput, now?: number): string;
  /** `1,250` · `1,250.5`; four-digit numbers are not grouped. */
  number(value: number | string | null | undefined, options?: Intl.NumberFormatOptions): string;
  /** An amount in EGP with two decimals: `1,250.00 EGP` · `1,250.00 ج.م` */
  money(amount: number | string | null | undefined): string;
  /** A ratio as a percentage: 0.125 → `12.5%` */
  percent(ratio: number | null | undefined, maximumFractionDigits?: number): string;
  /** `a, b and c` · `a وb وc` */
  list(items: readonly string[], type?: 'conjunction' | 'disjunction'): string;
}

const DASH = '—';
const CURRENCY: Record<Locale, string> = { en: 'EGP', ar: 'ج.م' };

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const cache = new Map<string, Format>();

export function createFormat(locale: Locale, options: { timeZone?: string } = {}): Format {
  const cacheKey = `${locale}|${options.timeZone ?? ''}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const tag = intlLocale(locale);
  const tz = options.timeZone ? { timeZone: options.timeZone } : {};
  const formats = new Map<string, Intl.DateTimeFormat>();
  const dtf = (o: Intl.DateTimeFormatOptions) => {
    const key = JSON.stringify(o);
    let f = formats.get(key);
    if (!f) {
      f = new Intl.DateTimeFormat(tag, o);
      formats.set(key, f);
    }
    return f;
  };
  const show = (value: DateInput, o: Intl.DateTimeFormatOptions) => {
    const d = toDate(value);
    return d ? dtf(o).format(d) : DASH;
  };
  const dateOpts = { day: '2-digit', month: 'short', year: 'numeric', ...tz } as const;
  const timeOpts = { hour: '2-digit', minute: '2-digit', ...tz } as const;
  const numbers = new Map<string, Intl.NumberFormat>();
  const nf = (o: Intl.NumberFormatOptions) => {
    const key = JSON.stringify(o);
    let f = numbers.get(key);
    if (!f) {
      f = new Intl.NumberFormat(tag, o);
      numbers.set(key, f);
    }
    return f;
  };
  const rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });

  const format: Format = {
    locale,
    date: (v) => show(v, dateOpts),
    dateTime: (v) => show(v, { ...dateOpts, ...timeOpts }),
    time: (v) => show(v, timeOpts),
    day: (v) => {
      const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(v ?? '');
      if (!m) return DASH;
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] ?? 1)));
      return m[3]
        ? dtf({ day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d)
        : dtf({ month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
    },
    month: (v) => {
      const m = /^(\d{4})-(\d{2})/.exec(v ?? '');
      if (!m) return DASH;
      return dtf({ month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)));
    },
    weekday: (day, width = 'long') =>
      // 2023-01-01 was a Sunday.
      dtf({ weekday: width, timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + (((day % 7) + 7) % 7)))),
    custom: (v, o) => show(v, { ...tz, ...o }),
    relative: (v, now = Date.now()) => {
      const d = toDate(v);
      if (!d) return DASH;
      const diff = Math.round((d.getTime() - now) / 1000);
      const abs = Math.abs(diff);
      if (abs < 60) return rtf.format(diff, 'second');
      if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
      if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
      return rtf.format(Math.round(diff / 86400), 'day');
    },
    number: (v, o) => {
      if (v === null || v === undefined || v === '') return DASH;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? nf({ maximumFractionDigits: 2, useGrouping: 'min2', ...o }).format(n) : DASH;
    },
    money: (amount) => {
      if (amount === null || amount === undefined || amount === '') return DASH;
      const n = typeof amount === 'number' ? amount : Number(amount);
      if (!Number.isFinite(n)) return DASH;
      return `${nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${CURRENCY[locale]}`;
    },
    percent: (ratio, digits = 1) =>
      ratio === null || ratio === undefined || !Number.isFinite(ratio)
        ? DASH
        : nf({ style: 'percent', maximumFractionDigits: digits }).format(ratio),
    list: (items, type = 'conjunction') => new Intl.ListFormat(tag, { type, style: 'long' }).format(items),
  };
  cache.set(cacheKey, format);
  return format;
}
