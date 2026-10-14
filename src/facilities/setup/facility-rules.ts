import type { FacilityCapacityUnit } from '@prisma/client';

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
    weeklyQuota: f.weeklyQuota!,
    peakQuota: f.peakQuota!,
  };
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
    weeklyQuota: given.weeklyQuota ?? RULE_RANGES.weeklyQuota.default,
    peakQuota: given.peakQuota ?? RULE_RANGES.peakQuota.default,
  };
}
