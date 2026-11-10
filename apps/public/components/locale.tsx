'use client';

import {
  createFormat,
  formatMessage,
  I18nProvider,
  useLocale as useSharedLocale,
  type Format,
  type Locale,
  type MessageParams,
} from '@jiwar/i18n';
import { useCallback, useMemo } from 'react';
import { ar, type MessageKey } from '@/messages/ar';
import { en } from '@/messages/en';

export type { Locale };

const MESSAGES: Record<Locale, Record<MessageKey, string>> = { ar, en };

type LocaleContext = {
  locale: Locale;
  t: (key: MessageKey, params?: Record<string, unknown>) => string;
  toggle: () => void;
  /** Dates and amounts in this language (`@jiwar/i18n`), in the compound's zone when it is given. */
  format: (timeZone?: string) => Format;
};

/**
 * Arabic first. The server renders `<html lang dir>` from the language
 * cookie (the choice alone, no secret); the switch changes the language in
 * place, with no navigation and no URL change, so a page keeps the token it
 * holds in memory.
 */
export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <I18nProvider locale={locale}>{children}</I18nProvider>;
}

export function useLocale(): LocaleContext {
  const { locale, setLocale } = useSharedLocale();
  const toggle = useCallback(() => setLocale(locale === 'ar' ? 'en' : 'ar'), [locale, setLocale]);
  return useMemo<LocaleContext>(
    () => ({
      locale,
      toggle,
      t: (key, params) => formatMessage(locale, MESSAGES[locale][key], params as MessageParams | undefined),
      format: (timeZone) => createFormat(locale, timeZone ? { timeZone } : {}),
    }),
    [locale, toggle],
  );
}
