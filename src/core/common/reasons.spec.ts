import { AppException } from './errors';
import { REASON_CODES, requireReasonCode } from './reasons';

function body(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppException) return error.getResponse();
    throw error;
  }
  throw new Error('expected an AppException');
}

describe('requireReasonCode', () => {
  const allowed = REASON_CODES.permissionRevoke;

  it('returns the trimmed code and text', () => {
    expect(
      requireReasonCode(
        { code: ' misuse ', text: '  shared the code ' },
        allowed,
      ),
    ).toEqual({ code: 'misuse', text: 'shared the code' });
  });

  it.each([
    [undefined, ['reasonCode', 'reason']],
    [{ code: 'misuse' }, ['reason']],
    [{ text: 'why' }, ['reasonCode']],
    [{ code: '  ', text: '  ' }, ['reasonCode', 'reason']],
  ])('%j → REASON_REQUIRED naming %j', (input, fields) => {
    expect(body(() => requireReasonCode(input, allowed))).toMatchObject({
      code: 'REASON_REQUIRED',
      fields: fields.map((field) => ({ field, code: 'FIELD_REQUIRED' })),
    });
  });

  it('a code outside the closed list is INVALID_REASON_CODE, with the list', () => {
    expect(
      body(() => requireReasonCode({ code: 'because', text: 'x' }, allowed)),
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: [
        {
          field: 'reasonCode',
          code: 'INVALID_REASON_CODE',
          params: { allowed: [...allowed] },
        },
      ],
    });
  });

  it('text over the limit is refused', () => {
    expect(
      body(() =>
        requireReasonCode({ code: 'misuse', text: 'x'.repeat(1001) }, allowed),
      ),
    ).toMatchObject({ fields: [{ field: 'reason', code: 'INVALID_LENGTH' }] });
  });

  it('every closed list is non-empty, snake_case, without duplicates', () => {
    for (const [name, codes] of Object.entries(REASON_CODES)) {
      expect(codes.length).toBeGreaterThan(0);
      expect(new Set(codes).size).toBe(codes.length);
      for (const code of codes) expect(`${name}:${code}`).toMatch(/:[a-z_]+$/);
    }
  });
});
