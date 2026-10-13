'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ar, type MessageKey } from '@/messages/ar';
import { en } from '@/messages/en';
import { format } from '@/lib/errors';

export type Locale = 'ar' | 'en';

const MESSAGES: Record<Locale, Record<MessageKey, string>> = { ar, en };
// The language choice only; a link's token is never stored anywhere.
const STORAGE_KEY = 'jiwar.locale';

type LocaleContext = {
  locale: Locale;
  t: (key: MessageKey, params?: Record<string, unknown>) => string;
  toggle: () => void;
};

const Context = createContext<LocaleContext | null>(null);

/**
 * Arabic first. The language is switched in place: no navigation and no URL
 * change, so a page keeps the token it holds in memory.
 */
export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>('ar');

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === 'en') setLocale('en');
    } catch {
      // Storage is blocked: Arabic stays.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);

  const toggle = useCallback(() => {
    setLocale((current) => {
      const next = current === 'ar' ? 'en' : 'ar';
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Not remembered, still switched.
      }
      return next;
    });
  }, []);

  const value = useMemo<LocaleContext>(
    () => ({ locale, toggle, t: (key, params) => format(MESSAGES[locale][key], params) }),
    [locale, toggle],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useLocale(): LocaleContext {
  const value = useContext(Context);
  if (!value) throw new Error('useLocale outside LocaleProvider');
  return value;
}
