import {
  checkBirthDate,
  checkIdentityDocument,
  type IdentityDocumentInput,
} from './identity-document';
import { ISO_COUNTRIES } from './iso-countries';

const TODAY = new Date(Date.UTC(2026, 8, 30));
const check = (input: IdentityDocumentInput) =>
  checkIdentityDocument(input, TODAY);
const codes = (input: IdentityDocumentInput) => {
  const r = check(input);
  return 'fields' in r ? r.fields.map((f) => `${f.field}:${f.code}`) : [];
};

describe('identity documents', () => {
  describe('national ID', () => {
    it('derives the birth date and ignores one sent by the client', () => {
      expect(
        check({
          idDocumentType: 'national_id',
          idDocumentNumber: '29001010100011',
          birthDate: '2001-05-05',
        }),
      ).toEqual({
        document: {
          idDocumentType: 'national_id',
          idDocumentNumber: '29001010100011',
          nationality: 'EG',
          birthDate: new Date(Date.UTC(1990, 0, 1)),
        },
      });
    });

    it('rejects an invalid ID and a non-Egyptian nationality', () => {
      expect(
        codes({ idDocumentType: 'national_id', idDocumentNumber: '123' }),
      ).toEqual(['idDocumentNumber:INVALID_NATIONAL_ID']);
      expect(
        codes({
          idDocumentType: 'national_id',
          idDocumentNumber: '29001010100011',
          nationality: 'SD',
        }),
      ).toEqual(['nationality:INVALID_NATIONALITY']);
    });
  });

  describe('passport', () => {
    const passport = (over: Partial<IdentityDocumentInput> = {}) =>
      ({
        idDocumentType: 'passport',
        idDocumentNumber: 'p 1234567',
        nationality: 'sd',
        birthDate: '1985-07-14',
        ...over,
      }) as IdentityDocumentInput;

    it('normalizes the number and nationality and keeps the entered date', () => {
      expect(check(passport())).toEqual({
        document: {
          idDocumentType: 'passport',
          idDocumentNumber: 'P1234567',
          nationality: 'SD',
          birthDate: new Date(Date.UTC(1985, 6, 14)),
        },
      });
    });

    it.each([
      ['1234', 'idDocumentNumber:INVALID_PASSPORT_NUMBER'],
      ['A'.repeat(21), 'idDocumentNumber:INVALID_PASSPORT_NUMBER'],
      ['AB-12345', 'idDocumentNumber:INVALID_PASSPORT_NUMBER'],
    ])('number %s → %s', (idDocumentNumber, expected) => {
      expect(codes(passport({ idDocumentNumber }))).toEqual([expected]);
    });

    it('accepts XK (Kosovo), which is not an official ISO code', () => {
      expect(ISO_COUNTRIES.has('XK')).toBe(false);
      expect(ISO_COUNTRIES.size).toBe(249);
      expect(check(passport({ nationality: 'xk' }))).toMatchObject({
        document: { nationality: 'XK' },
      });
    });

    it.each([
      [undefined, 'nationality:INVALID_NATIONALITY'],
      ['XX', 'nationality:INVALID_NATIONALITY'],
      ['SDN', 'nationality:INVALID_NATIONALITY'],
    ])('nationality %p → %s', (nationality, expected) => {
      expect(codes(passport({ nationality }))).toEqual([expected]);
    });

    it.each([
      [undefined, 'birthDate:BIRTH_DATE_REQUIRED'],
      ['', 'birthDate:BIRTH_DATE_REQUIRED'],
      ['2026-10-01', 'birthDate:INVALID_BIRTH_DATE'], // tomorrow
      ['1990-02-30', 'birthDate:INVALID_BIRTH_DATE'],
      ['01/02/1990', 'birthDate:INVALID_BIRTH_DATE'],
      ['1905-01-01', 'birthDate:INVALID_BIRTH_DATE'], // 121 years
    ])('birth date %p → %s', (birthDate, expected) => {
      expect(codes(passport({ birthDate }))).toEqual([expected]);
    });

    it('reports every problem at once', () => {
      expect(
        codes({
          idDocumentType: 'passport',
          idDocumentNumber: '1',
          nationality: 'ZZ',
        }),
      ).toEqual([
        'idDocumentNumber:INVALID_PASSPORT_NUMBER',
        'nationality:INVALID_NATIONALITY',
        'birthDate:BIRTH_DATE_REQUIRED',
      ]);
    });
  });

  it('an unknown document type', () => {
    expect(
      codes({
        idDocumentType: 'driving_licence' as 'passport',
        idDocumentNumber: 'X',
      }),
    ).toEqual(['idDocumentType:INVALID_VALUE']);
  });

  it('age up to 120, today allowed, Date input normalized to the calendar day', () => {
    expect(checkBirthDate('1906-09-30', TODAY)).toHaveProperty('date');
    expect(checkBirthDate('2026-09-30', TODAY)).toHaveProperty('date');
    expect(checkBirthDate(new Date('1990-05-05T13:45:00Z'), TODAY)).toEqual({
      date: new Date(Date.UTC(1990, 4, 5)),
    });
  });
});
