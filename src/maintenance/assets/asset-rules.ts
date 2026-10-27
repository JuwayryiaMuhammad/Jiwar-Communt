import { AREA_CODE } from '../locations/area-rules';
import { wholeYears, type LocalDate } from '../schedules/local-dates';

/**
 * The asset register's closed lists and limits (ADR 0064); the migration's
 * CHECKs repeat them (a unit test keeps them in step).
 */
export const ASSET_STATUSES = [
  'in_service',
  'out_of_service',
  'retired',
] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export const ASSET_CONDITIONS = ['good', 'fair', 'poor', 'critical'] as const;
export type AssetCondition = (typeof ASSET_CONDITIONS)[number];
export const ASSET_CRITICALITIES = [
  'low',
  'medium',
  'high',
  'critical',
] as const;
export type AssetCriticality = (typeof ASSET_CRITICALITIES)[number];
export const DOCUMENT_KINDS = [
  'plan',
  'manual',
  'warranty',
  'certificate',
  'photo',
  'other',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const ASSET_CODE = AREA_CODE;
export const ASSET_NAME = { min: 1, max: 120 };
export const ASSET_TEXT = { min: 1, max: 120 };
export const DOCUMENT_TITLE = { min: 1, max: 120 };
export const VENDOR_PHONE = /^[0-9+() -]{3,30}$/;
/** EGP, two decimals, under ten billion; zero allowed (a gift). */
export const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
export const LIFE_YEARS = { min: 1, max: 100 };
/** building → system → asset → component. */
export const MAX_DEPTH = 4;
export const MAX_SERVED_BUILDINGS = 50;

/**
 * An asset's health, 0–100, by rule (ADR 0064): never stored, read with
 * the card. It starts at 100 and loses for its condition, being out of
 * service, its age against its expected life, its open corrective tickets
 * and its overdue planned work.
 */
export interface HealthInput {
  condition: AssetCondition;
  status: AssetStatus;
  ageYears: number | null;
  lifeYears: number | null;
  openCorrective: number;
  overduePlanned: number;
}

export type HealthBand = 'good' | 'watch' | 'poor';

const CONDITION_COST: Record<AssetCondition, number> = {
  good: 0,
  fair: 15,
  poor: 35,
  critical: 60,
};

export function health(
  i: HealthInput,
): { score: number; band: HealthBand } | null {
  if (i.status === 'retired') return null;
  let score = 100 - CONDITION_COST[i.condition];
  if (i.status === 'out_of_service') score -= 20;
  if (i.ageYears !== null && i.lifeYears !== null) {
    const used = i.ageYears / i.lifeYears;
    if (used >= 1) score -= 25;
    else if (used >= 0.8) score -= 10;
  }
  score -= Math.min(30, 10 * i.openCorrective);
  score -= Math.min(20, 10 * i.overduePlanned);
  score = Math.max(0, Math.min(100, score));
  return { score, band: score >= 70 ? 'good' : score >= 40 ? 'watch' : 'poor' };
}

/** Whole years since commissioning, or null when unknown. */
export function ageYears(
  commissionedOn: LocalDate | null,
  today: LocalDate,
): number | null {
  if (commissionedOn === null) return null;
  return Math.max(0, wholeYears(commissionedOn, today));
}
