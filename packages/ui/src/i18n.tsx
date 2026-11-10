'use client';

import { useLocale, useT, type Locale } from '@jiwar/i18n';
import { Languages } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import { Button } from './button';
import commonAr from './messages/ar/common';
import codesAr from './messages/ar/codes';
import commonEn from './messages/en/common';
import codesEn from './messages/en/codes';

/** The shared words (`Cancel`, `Close`, `Status`…), in the page's language. */
export function useCommonT() {
  return useT(commonEn, commonAr);
}

export type CodeLabels = Readonly<Record<string, string>>;

/** A code's words when no catalog has it: `under_appeal` → `Under appeal`. */
export function humanizeCode(value: string): string {
  const text = value.replace(/[._]/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The words for a code the API returns (a status, a kind, a reason). A page
 * whose code means something else than the shared word passes its own
 * `overrides` (its catalog's `{ en, ar }` maps, keyed by the code); an
 * unknown code shows humanized rather than raw.
 */
export function useLabel(overrides?: { en: CodeLabels; ar: CodeLabels }) {
  const { locale } = useLocale();
  return useCallback(
    (code: string | null | undefined): string => {
      if (!code) return '—';
      const own = overrides?.[locale][code];
      if (own) return own;
      const shared = (locale === 'ar' ? codesAr : codesEn) as CodeLabels;
      return shared[code] ?? humanizeCode(code);
    },
    [locale, overrides],
  );
}

const NAMES: Record<Locale, string> = { ar: 'العربية', en: 'English' };

/**
 * Switches between Arabic and English in place and remembers the choice in
 * the language cookie; the server's parts (the page title) follow on refresh.
 * It names the other language in that language, so either reader finds it.
 */
export function LanguageSwitcher({ variant = 'secondary' }: { variant?: 'secondary' | 'ghost-dark' | 'text' }) {
  const { locale, setLocale } = useLocale();
  const router = useRouter();
  const t = useCommonT();
  const next: Locale = locale === 'ar' ? 'en' : 'ar';
  const label = useMemo(() => NAMES[next], [next]);
  return (
    <Button
      variant={variant}
      size="sm"
      icon={<Languages aria-hidden />}
      lang={next}
      aria-label={`${t('shell.language')}: ${label}`}
      onClick={() => {
        setLocale(next);
        router.refresh();
      }}
    >
      {label}
    </Button>
  );
}
