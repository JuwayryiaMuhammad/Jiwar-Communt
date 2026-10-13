import { AppException, type AppErrorBody } from '../../core/common/errors';
import { localized, namesText, sameText } from './localized';

const FIELDS = [
  { name: 'title', max: 10 },
  { name: 'body', max: 20 },
];

function fieldsOf(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppException)
      return (error.getResponse() as AppErrorBody).fields;
    throw error;
  }
  return null;
}

describe('localized (ADR 0040)', () => {
  it('takes English, Arabic or both, trimmed; an absent language is null', () => {
    expect(localized({ titleEn: ' Hi ', bodyEn: 'There' }, FIELDS)).toEqual({
      titleEn: 'Hi',
      bodyEn: 'There',
      titleAr: null,
      bodyAr: null,
    });
    expect(
      localized(
        { titleEn: 'Hi', bodyEn: 'There', titleAr: 'أهلا', bodyAr: 'مرحبا' },
        FIELDS,
      ),
    ).toMatchObject({ titleAr: 'أهلا', bodyAr: 'مرحبا' });
  });

  it('a language is whole or absent, and at least one is there', () => {
    expect(fieldsOf(() => localized({ titleEn: 'Hi' }, FIELDS))).toEqual([
      { field: 'bodyEn', code: 'FIELD_REQUIRED' },
    ]);
    expect(fieldsOf(() => localized({}, FIELDS))).toEqual([
      { field: 'titleEn', code: 'FIELD_REQUIRED' },
    ]);
    // Blank is absent.
    expect(
      fieldsOf(() => localized({ titleEn: '  ', bodyEn: '' }, FIELDS)),
    ).toEqual([{ field: 'titleEn', code: 'FIELD_REQUIRED' }]);
  });

  it('too long is INVALID_LENGTH with the limits, under the given prefix', () => {
    expect(
      fieldsOf(() =>
        localized(
          { titleEn: 'x'.repeat(11), bodyEn: 'ok' },
          FIELDS,
          undefined,
          'summary.',
        ),
      ),
    ).toEqual([
      {
        field: 'summary.titleEn',
        code: 'INVALID_LENGTH',
        params: { min: 1, max: 10 },
      },
    ]);
  });

  it('an edit keeps what it does not name and clears what it nulls', () => {
    const base = {
      titleEn: 'Hi',
      bodyEn: 'There',
      titleAr: 'أهلا',
      bodyAr: 'مرحبا',
    };
    expect(localized({ bodyEn: 'Again' }, FIELDS, base)).toEqual({
      ...base,
      bodyEn: 'Again',
    });
    expect(localized({ titleAr: null, bodyAr: null }, FIELDS, base)).toEqual({
      titleEn: 'Hi',
      bodyEn: 'There',
      titleAr: null,
      bodyAr: null,
    });
    // Clearing half of a language leaves it broken.
    expect(fieldsOf(() => localized({ titleAr: null }, FIELDS, base))).toEqual([
      { field: 'titleAr', code: 'FIELD_REQUIRED' },
    ]);
  });

  it('namesText and sameText', () => {
    expect(namesText({ priority: 'x' }, FIELDS)).toBe(false);
    expect(namesText({ bodyAr: null }, FIELDS)).toBe(true);
    expect(sameText({ titleEn: 'a', titleAr: null }, { titleEn: 'a' })).toBe(
      true,
    );
    expect(sameText({ titleEn: 'a' }, { titleEn: 'b' })).toBe(false);
  });
});
