/** A fine is appealed within this many days of being issued. */
export const APPEAL_DAYS = 30;
/** It happened at most this many days before it is issued. */
export const OCCURRED_DAYS = 90;
/** A payment is recorded at most this many days after it was made. */
export const PAID_ON_DAYS = 90;
export const CURRENCY = 'EGP';

export const NOTE = { min: 1, max: 500 } as const;
export const APPEAL_TEXT = { min: 1, max: 1000 } as const;

/** EGP, more than 0 and at most 100,000, two decimals at most. */
export const FINE_AMOUNT = /^(?!0+(\.0{1,2})?$)\d{1,6}(\.\d{1,2})?$/;
export const MAX_AMOUNT = 100_000;
export const RECEIPT = /^[A-Za-z0-9/-]{1,40}$/;

/** What a resident filters by: `unpaid` includes what is under appeal. */
export type ResidentFineFilter = 'unpaid' | 'paid' | 'cancelled';
