import { useT } from '@jiwar/i18n';
import { useLabel } from '@jiwar/ui';
import { useCallback } from 'react';
import ar from '@/messages/ar/fin-codes';
import en from '@/messages/en/fin-codes';

export type FinanceCodeGroup = 'kind' | 'frequency' | 'method' | 'outcome' | 'ledger' | 'refundChannel';

/** The fin-codes catalog, for the finance helpers that take a `t`. */
export function useFinanceT() {
  return useT(en, ar);
}

/**
 * The words for a finance code in the page's language: the finance meaning
 * (`outcome.applied` is “Paid”), else the shared word, else the code humanized.
 */
export function useFinanceCode() {
  const t = useT(en, ar);
  const label = useLabel();
  return useCallback(
    (group: FinanceCodeGroup, code: string | null | undefined): string => {
      if (!code) return '—';
      const key = `${group}.${code}`;
      return key in en ? t(key as keyof typeof en) : label(code);
    },
    [t, label],
  );
}
