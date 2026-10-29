import { FieldErrorCode, type FieldError } from '../../core/common/errors';

/** What an outage cuts (ADR 0066); the migration's CHECK repeats them. */
export const OUTAGE_SCOPES = ['compound', 'buildings'] as const;
export type OutageScope = (typeof OUTAGE_SCOPES)[number];
/** The most buildings one outage names. */
export const OUTAGE_MAX_BUILDINGS = 50;

/**
 * The whole compound names no building; `buildings` names at least one
 * (ADR 0066). The CHECK `utility_outages_scope_shape` holds the same.
 */
export function scopeProblems(
  scope: OutageScope,
  buildings: readonly string[],
): FieldError[] {
  if (scope === 'compound' && buildings.length)
    return [{ field: 'buildings', code: FieldErrorCode.FIELD_NOT_ALLOWED }];
  if (scope === 'buildings' && !buildings.length)
    return [{ field: 'buildings', code: FieldErrorCode.FIELD_REQUIRED }];
  return [];
}
