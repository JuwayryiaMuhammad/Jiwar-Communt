/**
 * The partners' pages (ADR 0060): words for the codes, and the small rules
 * the forms check before the API does. Plain TypeScript with no imports,
 * so the tests run it as is.
 */

export const CATEGORY_TEXT: Record<string, string> = {
  gas_water: 'Gas & water',
  pharmacy: 'Pharmacy',
  grocery: 'Grocery',
  home_services: 'Home services',
  laundry: 'Laundry & carpets',
  gardening: 'Gardening',
  beauty_at_home: 'Barber & salon at home',
  repair: 'Repairs',
  pets: 'Pets',
  events: 'Event setup',
  moving_storage: 'Moving & storage',
  car_services: 'Car services',
  elderly_care: 'Elderly care',
};

/** The closed list, in its order. */
export const CATEGORIES = Object.keys(CATEGORY_TEXT);

export const PRICE_UNIT_TEXT: Record<string, string> = {
  fixed: 'Fixed',
  per_visit: 'Per visit',
  visit_fee: 'Visit fee',
  per_hour: 'Per hour',
  per_item: 'Per item',
  per_kg: 'Per kg',
  per_sqm: 'Per m²',
};

export const REQUEST_STATUS_TEXT: Record<string, string> = {
  pending: 'Waiting for the partner',
  proposed: 'Another time proposed',
  accepted: 'Accepted',
  declined: 'Declined',
  cancelled: 'Cancelled',
  expired: 'Expired',
  done: 'Done',
  partner_no_show: 'Partner did not come',
  lapsed: 'Lapsed',
};

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

/** "SR-000123 · Home services / Cleaning". */
export function requestTitle(r: { number: string; category: string; subcategory: { nameEn: string } | null }): string {
  const what = CATEGORY_TEXT[r.category] ?? r.category;
  return `${r.number} · ${r.subcategory ? `${what} / ${r.subcategory.nameEn}` : what}`;
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
export function ratingText(r: { average: string; count: number } | null | undefined): string {
  return r ? `${r.average} (${r.count})` : 'No ratings';
}

/** The closed lists a complaint is decided with, in words. */
export const OUTCOME_TEXT: Record<string, string> = { upheld: 'Upheld', not_upheld: 'Not upheld' };
export const COMPENSATION_TEXT: Record<string, string> = {
  none: 'Nothing',
  redo: 'The partner does it again',
  partner_refund: 'The partner refunds',
  credit_note: 'A credit note (issued in Finance)',
};

/** A decision not upheld arranges nothing. */
export function compensationsFor(outcome: string): string[] {
  return outcome === 'not_upheld' ? ['none'] : Object.keys(COMPENSATION_TEXT);
}
