import type { FacilityCapacityUnit, Prisma } from '@prisma/client';

// ============================================================================
// A bookable facility's rules (ADR 0044)
// ============================================================================

/**
 * The CHECK facilities_rules_ranges, and the defaults a new bookable
 * facility gets for what the manager leaves out. `slotMinutes` and
 * `capacity` have no default: every facility says its own.
 */
export const RULE_RANGES = {
  slotMinutes: { min: 15, max: 480, default: null },
  capacity: { min: 1, max: 500, default: null },
  maxDaysAhead: { min: 1, max: 90, default: 14 },
  minMinutesBefore: { min: 0, max: 10080, default: 60 },
  cancelCutoffMinutes: { min: 0, max: 10080, default: 120 },
  maxGuests: { min: 0, max: 50, default: 0 },
  weeklyQuota: { min: 1, max: 20, default: 2 },
  peakQuota: { min: 1, max: 20, default: 1 },
} as const;
export type FacilityRuleName = keyof typeof RULE_RANGES;

/** The number of a facility's position in the compound's list. */
export const POSITION = { min: 0, max: 1000 } as const;
/** At most four windows a day, for the hours and for the peaks. */
export const MAX_WINDOWS = 28;

/** Everything a bookable facility is booked by. */
export interface FacilityRules {
  slotMinutes: number;
  capacity: number;
  capacityUnit: FacilityCapacityUnit;
  maxDaysAhead: number;
  minMinutesBefore: number;
  cancelCutoffMinutes: number;
  maxGuests: number;
  requiresApproval: boolean;
  requiresMembership: boolean;
  /** A booking may name one of the unit's minors as its occasion (ADR 0054). */
  childOccasions: boolean;
  weeklyQuota: number;
  peakQuota: number;
}

/** The rules of a facility row, or null for a walk-in one. */
export function rulesOf(f: {
  mode: 'bookable' | 'walk_in';
  slotMinutes: number | null;
  capacity: number | null;
  capacityUnit: FacilityCapacityUnit | null;
  maxDaysAhead: number | null;
  minMinutesBefore: number | null;
  cancelCutoffMinutes: number | null;
  maxGuests: number | null;
  requiresApproval: boolean;
  requiresMembership: boolean;
  childOccasions: boolean;
  weeklyQuota: number | null;
  peakQuota: number | null;
}): FacilityRules | null {
  if (f.mode !== 'bookable') return null;
  return {
    slotMinutes: f.slotMinutes!,
    capacity: f.capacity!,
    capacityUnit: f.capacityUnit!,
    maxDaysAhead: f.maxDaysAhead!,
    minMinutesBefore: f.minMinutesBefore!,
    cancelCutoffMinutes: f.cancelCutoffMinutes!,
    maxGuests: f.maxGuests!,
    requiresApproval: f.requiresApproval,
    requiresMembership: f.requiresMembership,
    childOccasions: f.childOccasions,
    weeklyQuota: f.weeklyQuota!,
    peakQuota: f.peakQuota!,
  };
}

// ============================================================================
// What a booking costs (ADR 0070)
// ============================================================================

/** A booking's fee, EGP: more than zero, below 100,000 (CHECK facilities_fees). */
export const FEE_AMOUNT = /^(?!0+(\.0{1,2})?$)\d{1,5}(\.\d{1,2})?$/;
/** A resident who cancels this many hours or more before the start is credited in full. */
export const REFUND_CUTOFF_HOURS = { min: 0, max: 168, default: 24 } as const;

export const FEE_FIELDS = [
  'feeAmount',
  'peakFeeAmount',
  'refundCutoffHours',
] as const;

export interface FeeInput {
  feeAmount?: string | null;
  peakFeeAmount?: string | null;
  refundCutoffHours?: number;
}

/** A facility's fees as views and the audit show them; null for a walk-in one. */
export interface FacilityFees {
  feeAmount: string | null;
  peakFeeAmount: string | null;
  refundCutoffHours: number;
}

export function feesOf(f: {
  mode: string;
  feeAmount: Prisma.Decimal | null;
  peakFeeAmount: Prisma.Decimal | null;
  refundCutoffHours: number;
}): FacilityFees | null {
  if (f.mode === 'walk_in') return null;
  return {
    feeAmount: f.feeAmount?.toFixed(2) ?? null,
    peakFeeAmount: f.peakFeeAmount?.toFixed(2) ?? null,
    refundCutoffHours: f.refundCutoffHours,
  };
}

/** What a booking of a slot costs, peak or not; null: free. */
export function feeFor(
  f: {
    feeAmount: Prisma.Decimal | null;
    peakFeeAmount: Prisma.Decimal | null;
  },
  peak: boolean,
): Prisma.Decimal | null {
  return (peak ? f.peakFeeAmount : null) ?? f.feeAmount;
}

/** A new bookable facility's rules: what was given, then the defaults. */
export function withDefaults(
  given: Partial<FacilityRules> & { slotMinutes: number; capacity: number },
): FacilityRules {
  return {
    slotMinutes: given.slotMinutes,
    capacity: given.capacity,
    capacityUnit: given.capacityUnit ?? 'bookings',
    maxDaysAhead: given.maxDaysAhead ?? RULE_RANGES.maxDaysAhead.default,
    minMinutesBefore:
      given.minMinutesBefore ?? RULE_RANGES.minMinutesBefore.default,
    cancelCutoffMinutes:
      given.cancelCutoffMinutes ?? RULE_RANGES.cancelCutoffMinutes.default,
    maxGuests: given.maxGuests ?? RULE_RANGES.maxGuests.default,
    requiresApproval: given.requiresApproval ?? false,
    requiresMembership: given.requiresMembership ?? false,
    childOccasions: given.childOccasions ?? false,
    weeklyQuota: given.weeklyQuota ?? RULE_RANGES.weeklyQuota.default,
    peakQuota: given.peakQuota ?? RULE_RANGES.peakQuota.default,
  };
}
