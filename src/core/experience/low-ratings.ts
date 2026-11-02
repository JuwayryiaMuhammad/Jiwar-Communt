import { FieldErrorCode } from '../common/errors';
import { invalid } from '../common/localized';
import { REASON_CODES } from '../common/reasons';

/** A rating at or below this is low (ADR 0082): it says why. */
export const LOW_RATING_MAX = 2;

export type LowRatingReason = (typeof REASON_CODES.lowRating)[number];

/**
 * A low rating's reason (ADR 0082): on a rating of 1 or 2, from
 * REASON_CODES.lowRating, and refused on a higher one. Optional for now:
 * a low rating without one is taken (null) until the resident apps ship
 * the picker; the reports count it as unstated. The same rule on a
 * ticket's confirmation, a management request's rating and a partner
 * request's; `field` is the body's name for it.
 */
export function lowRatingReason(
  rating: number,
  code: string | undefined | null,
  field = 'lowReasonCode',
): LowRatingReason | null {
  if (rating > LOW_RATING_MAX) {
    if (code !== undefined && code !== null)
      throw invalid([{ field, code: FieldErrorCode.FIELD_NOT_ALLOWED }]);
    return null;
  }
  if (code === undefined || code === null || code === '') return null;
  if (!(REASON_CODES.lowRating as readonly string[]).includes(code))
    throw invalid([
      {
        field,
        code: FieldErrorCode.INVALID_REASON_CODE,
        params: { allowed: [...REASON_CODES.lowRating] },
      },
    ]);
  return code as LowRatingReason;
}
