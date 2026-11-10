/**
 * The two languages of the dashboards and the public pages (the owner's
 * decision of 2026-11-10): Arabic, the default, right to left, and English.
 */
export const LOCALES = ['ar', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'ar';

/**
 * The language choice, and nothing else: no secret, readable by the page's
 * script (the switcher writes it), sent to the server so the first render is
 * already in the right language and direction. It stays out of the URLs.
 */
export const LOCALE_COOKIE = 'jiwar_locale';
const ONE_YEAR = 60 * 60 * 24 * 365;

/** Anything but `en` is Arabic: a missing or tampered cookie falls back to the default. */
export function parseLocale(value: string | null | undefined): Locale {
  return value === 'en' ? 'en' : DEFAULT_LOCALE;
}

export function dirOf(locale: Locale): 'rtl' | 'ltr' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

/**
 * The tag handed to Intl. Arabic is Egypt's, with Western digits (`nu-latn`):
 * the codes, references, phone numbers, plates and amounts the dashboards show
 * and take are typed in Western digits, so one row never mixes two digit
 * systems, money columns line up and compare at a glance, and what is copied
 * into a spreadsheet stays a number. English keeps the dashboards' day-month
 * order (en-GB).
 */
export function intlLocale(locale: Locale): string {
  return locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB';
}

/** The `Set-Cookie`/`document.cookie` value that remembers the choice. */
export function localeCookie(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax`;
}

/** The value of the language cookie in a `Cookie` header or `document.cookie`. */
export function localeFromCookieHeader(header: string | null | undefined): Locale {
  const match = (header ?? '').match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]*)`));
  return parseLocale(match?.[1]);
}
