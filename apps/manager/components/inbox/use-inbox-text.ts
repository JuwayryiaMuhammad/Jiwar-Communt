'use client';

import { useT } from '@jiwar/i18n';
import { useLabel } from '@jiwar/ui';
import ar from '@/messages/ar/inbox';
import en from '@/messages/en/inbox';
import { INBOX_TYPE } from './inbox-types';

/**
 * The inbox's words in the page's language: what a type is called ("Unit
 * permit") and how long something has waited ("3 h", "2 d"). `INBOX_TYPE`
 * keeps the routes; the labels there are the English fallback only.
 */
export function useInboxText() {
  const t = useT(en, ar);
  const label = useLabel();
  return {
    type: (type: string): string => (type in INBOX_TYPE ? t(`type.${type}` as keyof typeof en) : label(type)),
    waited: (since: string, now: number): string => {
      const h = Math.max(0, Math.floor((now - new Date(since).getTime()) / 3_600_000));
      return h < 48 ? t('hours', { n: h }) : t('days', { n: Math.floor(h / 24) });
    },
  };
}
