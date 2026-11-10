'use client';

import { useT } from '@jiwar/i18n';
import ar from '@/messages/ar/complaints';
import en from '@/messages/en/complaints';

type Person = { fullName?: string | null; erased?: boolean } | null | undefined;
type UnitRef = { code: string; building?: string | null } | null | undefined;

/**
 * How the complaint and conversation-report screens name a person or a
 * unit, in the page's language ("Erased account" when the account was erased).
 */
export function useWho() {
  const t = useT(en, ar);
  return {
    person: (p: Person): string => (p ? (p.erased ? t('erasedAccount') : (p.fullName ?? t('unnamedAccount'))) : '—'),
    unit: (u: UnitRef): string => (u ? (u.building ? `${u.code} · ${u.building}` : u.code) : '—'),
  };
}
