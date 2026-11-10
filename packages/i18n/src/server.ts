import 'server-only';
import { cookies } from 'next/headers';
import { dirOf, LOCALE_COOKIE, parseLocale, type Locale } from './locale.ts';

/** The request's language, for the root layout's `<html lang dir>` and its metadata. */
export async function requestLocale(): Promise<{ locale: Locale; dir: 'rtl' | 'ltr' }> {
  const locale = parseLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return { locale, dir: dirOf(locale) };
}
