import type { FieldError } from '../../core/common/errors';
import { FieldErrorCode } from '../../core/common/errors';

/** Inspections (ADR 0064): the statuses the migration's CHECK repeats. */
export const INSPECTION_STATUSES = [
  'scheduled',
  'in_progress',
  'submitted',
  'cancelled',
] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];
/** Open: an inspector may still start, answer, submit; dispatch may cancel. */
export const OPEN_INSPECTION: readonly InspectionStatus[] = [
  'scheduled',
  'in_progress',
];
export const ROUND_TITLE = { min: 1, max: 120 };
export const ROUND_LEAD = { min: 0, max: 60 };
/** The longest period a report covers, in days. */
export const REPORT_DAYS = 366;

/** A target is an asset or a common area: exactly one. */
export function targetProblems(t: {
  assetId?: string;
  commonAreaId?: string;
}): FieldError[] {
  if (t.assetId !== undefined && t.commonAreaId !== undefined)
    return [{ field: 'commonAreaId', code: FieldErrorCode.FIELD_NOT_ALLOWED }];
  if (t.assetId === undefined && t.commonAreaId === undefined)
    return [{ field: 'assetId', code: FieldErrorCode.FIELD_REQUIRED }];
  return [];
}

/** A follow-up's words: the item's label and, when given, the inspector's note. */
export function findingText(labelEn: string, note: string | null): string {
  return (note ? `${labelEn}: ${note}` : labelEn).slice(0, 2000);
}
