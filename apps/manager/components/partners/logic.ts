/**
 * The partners' pages (ADR 0060): the closed lists, the words for their codes
 * (the partners-codes catalog, through the `t` a caller hands in), and the
 * small rules the forms check before the API does. No React and no `@/`
 * alias, so the tests run it as is.
 */
import type { Translate } from '@jiwar/i18n';
import en from '../../messages/en/partners-codes.ts';

export type PartnerT = Translate<typeof en>;

/** The closed list of categories, in its order. */
export const CATEGORIES = [
  'gas_water',
  'pharmacy',
  'grocery',
  'home_services',
  'laundry',
  'gardening',
  'beauty_at_home',
  'repair',
  'pets',
  'events',
  'moving_storage',
  'car_services',
  'elderly_care',
];

export const PRICE_UNITS = ['fixed', 'per_visit', 'visit_fee', 'per_hour', 'per_item', 'per_kg', 'per_sqm'];

export const OUTCOMES = ['upheld', 'not_upheld'];
export const COMPENSATIONS = ['none', 'redo', 'partner_refund', 'credit_note'];

const isKey = (key: string): key is keyof typeof en & string => key in en;

/** A code in words: `word(t, 'category', 'pets')`; a code the catalog lacks reads humanized. */
export function word(t: PartnerT, group: 'category' | 'unit' | 'status' | 'outcome' | 'compensation', code: string): string {
  const key = `${group}.${code}`;
  if (isKey(key)) return t(key);
  const text = code.replace(/[._]/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Statuses a request is still open in. */
export const LIVE_STATUSES = ['pending', 'proposed', 'accepted'];

/** What the relay may do for the partner, from the request's status. */
export function relayActions(status: string, consentWithdrawn: boolean) {
  if (consentWithdrawn) return { accept: false, decline: false, propose: false, done: false, cancel: false };
  return {
    accept: status === 'pending',
    decline: status === 'pending' || status === 'proposed',
    propose: status === 'pending',
    done: status === 'accepted',
    cancel: status === 'accepted',
  };
}

/** "SR-000123 · Home services / Cleaning"; the sub-category as the page's language names it. */
export function requestTitle(
  t: PartnerT,
  r: { number: string; category: string; subcategory: { nameEn: string; nameAr?: string | null } | null },
  locale = 'en',
): string {
  const what = word(t, 'category', r.category);
  const sub = r.subcategory ? (locale === 'ar' && r.subcategory.nameAr ? r.subcategory.nameAr : r.subcategory.nameEn) : null;
  return `${r.number} · ${sub ? `${what} / ${sub}` : what}`;
}

/** EGP with two decimals at most, zero allowed, below a million: a price line. */
export function validPrice(value: string): boolean {
  return /^\d{1,6}(\.\d{1,2})?$/.test(value.trim());
}

/** An E.164 or local Egyptian number, loosely: the API decides. */
export function looksLikePhone(value: string): boolean {
  return /^\+?[0-9 ]{7,16}$/.test(value.trim());
}

/** Days until an instant, at least 0, rounded up: a desk link's life left. */
export function daysLeft(until: string, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((new Date(until).getTime() - now.getTime()) / 86_400_000));
}

/** "4.3 (12)", or "No ratings". */
export function ratingText(t: PartnerT, r: { average: string; count: number } | null | undefined): string {
  return r ? `${r.average} (${r.count})` : t('ratingNone');
}

/** A decision not upheld arranges nothing. */
export function compensationsFor(outcome: string): string[] {
  return outcome === 'not_upheld' ? ['none'] : [...COMPENSATIONS];
}
