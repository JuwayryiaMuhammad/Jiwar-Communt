import type {
  MarketListing,
  MarketListingKind,
  MarketListingStatus,
  Prisma,
} from '@prisma/client';

/**
 * The market's rules (ADR 0071), pure: what a listing needs, which states
 * are open, and the state a reader sees by the clock.
 */

export const LISTING_TITLE_LENGTH = { min: 3, max: 80 } as const;
export const LISTING_BODY_LENGTH = { min: 1, max: 2000 } as const;
/** Photos on one listing. */
export const MAX_LISTING_PHOTOS = 6;
/** A seller is told this long before a live listing's day. */
export const EXPIRY_NOTICE_MS = 2 * 86_400_000;
/** Searches an account may run in a minute, as `/me/search` allows. */
export const MARKET_SEARCH_RATE = { limit: 30, windowSeconds: 60 } as const;
/**
 * A positive price below 1,000,000,000 with two decimals at most (a unit's
 * price is the largest the market sees; the CHECK allows up to that).
 */
export const PRICE = /^(?!0+(\.0{1,2})?$)\d{1,9}(\.\d{1,2})?$/;

/** A unit for sale or to let: only its owner lists it. */
export const UNIT_KINDS: readonly MarketListingKind[] = [
  'unit_sale',
  'unit_rent',
];
/** These carry a price; a gift never does; the others may. */
export const PRICED_KINDS: readonly MarketListingKind[] = [
  'sell',
  'unit_sale',
  'unit_rent',
];

/** Not ended: counted against the seller's limit, and a unit's one listing. */
export const OPEN_STATUSES: readonly MarketListingStatus[] = [
  'pending_review',
  'live',
  'under_review',
];
/** Ended: never changes again. */
export const ENDED_STATUSES: readonly MarketListingStatus[] = [
  'rejected',
  'removed',
  'withdrawn',
  'sold',
  'expired',
];

/** What the system's withdrawals say (the state CHECK repeats them). */
export const SYSTEM_WITHDRAWALS = [
  'seller_left',
  'seller_erased',
  'owner_left',
] as const;
export type SystemWithdrawal = (typeof SYSTEM_WITHDRAWALS)[number];

export const isUnitKind = (kind: MarketListingKind): boolean =>
  UNIT_KINDS.includes(kind);

export const isOpen = (status: MarketListingStatus): boolean =>
  OPEN_STATUSES.includes(status);

/**
 * The state a reader sees: a live listing whose day passed reads expired
 * before the sweep marks it, so no reader ever finds it on the market.
 */
export function stateOf(
  l: Pick<MarketListing, 'status' | 'expiresAt'>,
  now: Date,
): MarketListingStatus {
  if (l.status === 'live' && l.expiresAt.getTime() <= now.getTime())
    return 'expired';
  return l.status;
}

/** On the market now, by the reader's clock. */
export const onMarket = (
  l: Pick<MarketListing, 'status' | 'expiresAt'>,
  now: Date,
): boolean => stateOf(l, now) === 'live';

/** A listing's day, `days` after `now`. */
export const expiryFrom = (now: Date, days: number): Date =>
  new Date(now.getTime() + days * 86_400_000);

/** The `where` of the listings on the market now. */
export const liveWhere = (now: Date): Prisma.MarketListingWhereInput => ({
  status: 'live',
  expiresAt: { gt: now },
});

/** A price check that names what is wrong, or null when the shape fits. */
export function priceProblem(
  kind: MarketListingKind,
  price: string | null,
): 'required' | 'not_allowed' | null {
  if (PRICED_KINDS.includes(kind) && price === null) return 'required';
  if (kind === 'give' && price !== null) return 'not_allowed';
  return null;
}
