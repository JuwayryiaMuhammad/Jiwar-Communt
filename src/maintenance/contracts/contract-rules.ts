import type { LocalDate } from '../schedules/local-dates';

/** What a maintenance contract is (ADR 0065); the migration's CHECK repeats them. */
export const CONTRACT_KINDS = [
  'amc',
  'service',
  'warranty_extension',
  // Every trade the compound contracts for (ADR 0077).
  'cleaning',
  'security',
  'landscaping',
  'pest_control',
  'supply',
  'other',
] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

/** Where a contract is on the compound's calendar, read from its dates. */
export const CONTRACT_STATUSES = [
  'upcoming',
  'active',
  'ended',
  'terminated',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_NOTICE_DAYS = { min: 0, max: 180 };
/** Assets one contract covers at most. */
export const CONTRACT_ASSETS_MAX = 200;
export const VENDOR_NAME = { min: 1, max: 120 };
export const CONTRACT_SCOPE = { min: 1, max: 1000 };
export const VENDOR_PHONE = /^[0-9+() -]{3,30}$/;
/** The terms a contract is run by (ADR 0077). */
export const CONTRACT_TERMS = {
  responseHours: { min: 1, max: 720 },
  renewalTermMonths: { min: 1, max: 60 },
  penaltyTerms: { min: 1, max: 1000 },
} as const;
/** Payments one schedule holds at most, and a payment's note. */
export const CONTRACT_PAYMENTS_MAX = 120;
export const PAYMENT_NOTE = { min: 1, max: 200 };
export const PAYMENT_REFERENCE = { min: 1, max: 120 };
/** A payment is announced this many days before it is due, once. */
export const PAYMENT_NOTICE_DAYS = 7;

/**
 * A contract's status on `today`, the compound's: terminated once and for
 * good; otherwise by its dates, the end date its last day.
 */
export function contractStatus(
  c: { startsOn: LocalDate; endsOn: LocalDate; terminated: boolean },
  today: LocalDate,
): ContractStatus {
  if (c.terminated) return 'terminated';
  if (today < c.startsOn) return 'upcoming';
  if (today > c.endsOn) return 'ended';
  return 'active';
}
