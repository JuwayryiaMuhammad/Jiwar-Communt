/** Where a purchase request is (ADR 0077); the migration's CHECK repeats them. */
export const PURCHASE_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'cancelled',
  'fulfilled',
] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

export const PURCHASE_LIMITS = {
  title: { min: 3, max: 200 },
  description: { min: 1, max: 2000 },
  note: { min: 1, max: 1000 },
  reference: { min: 1, max: 120 },
} as const;
/** A quantity of a stock item, as the store counts it (up to 3 decimals). */
export const QUANTITY = /^\d{1,6}(\.\d{1,3})?$/;

/** The number as shown: PR-0001. */
export const purchaseReference = (n: number) =>
  `PR-${String(n).padStart(4, '0')}`;
