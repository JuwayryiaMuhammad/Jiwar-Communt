import { AppException } from '../common/errors';
import { lowRatingReason } from './low-ratings';

const fields = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppException)
      return (e.getResponse() as { fields: { field: string; code: string }[] })
        .fields;
    throw e;
  }
  throw new Error('no error');
};

describe('a low rating’s reason (ADR 0082)', () => {
  it('is taken on 1 and 2, from the list; optional for now', () => {
    expect(lowRatingReason(1, 'slow')).toBe('slow');
    expect(lowRatingReason(2, 'not_fixed')).toBe('not_fixed');
    expect(lowRatingReason(2, undefined)).toBeNull();
    expect(lowRatingReason(1, '')).toBeNull();
    expect(fields(() => lowRatingReason(1, 'bad'))).toMatchObject([
      { field: 'lowReasonCode', code: 'INVALID_REASON_CODE' },
    ]);
  });

  it('is refused on 3 to 5, and absent is nothing', () => {
    expect(lowRatingReason(3, undefined)).toBeNull();
    expect(lowRatingReason(5, null)).toBeNull();
    expect(fields(() => lowRatingReason(4, 'slow', 'reason'))).toEqual([
      { field: 'reason', code: 'FIELD_NOT_ALLOWED' },
    ]);
  });
});
