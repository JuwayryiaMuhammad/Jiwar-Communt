'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { createFormat, type Format } from './format.ts';
import { dirOf, localeCookie, type Locale } from './locale.ts';
import { translator, type Messages, type Translate, type Translation } from './catalog.ts';

interface LocaleContextValue {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * The language of the page. The server reads it from the cookie and renders
 * `<html lang dir>` with it; switching changes it in place (no navigation, so
 * a page keeps its state) and remembers it in the cookie.
 */
export function I18nProvider({ locale: initial, children }: { locale: Locale; children: ReactNode }) {
  const [locale, setState] = useState<Locale>(initial);
  const setLocale = useCallback((next: Locale) => {
    document.cookie = localeCookie(next);
    document.documentElement.lang = next;
    document.documentElement.dir = dirOf(next);
    setState(next);
  }, []);
  const value = useMemo(() => ({ locale, dir: dirOf(locale), setLocale }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('useLocale outside I18nProvider');
  return value;
}

/** `t(key, params)` over one catalog, in the page's language. */
export function useT<M extends Messages>(en: M, ar: Translation<M>): Translate<M> {
  const { locale } = useLocale();
  return useMemo(() => translator(locale, en, ar), [locale, en, ar]);
}

/** Dates, numbers and amounts in the page's language (`createFormat`). */
export function useFormat(options: { timeZone?: string } = {}): Format {
  const { locale } = useLocale();
  return useMemo(() => createFormat(locale, options), [locale, options.timeZone]); // eslint-disable-line react-hooks/exhaustive-deps
}
