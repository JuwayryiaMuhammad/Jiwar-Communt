import type { IdDocumentType } from '@prisma/client';
import {
  ageOn,
  egyptToday,
  parseEgyptianNationalId,
} from './egyptian-national-id';
import { appError, ErrorCode, FieldErrorCode, type FieldError } from './errors';
import { ISO_COUNTRIES } from './iso-countries';

// ============================================================================
// Identity documents (ADR 0018): an Egyptian national ID or a passport.
// Every document has a type, and the birth date is always stored — derived
// from a national ID, entered for a passport.
// ============================================================================

/** As callers and DTOs send it. */
export interface IdentityDocumentInput {
  idDocumentType: IdDocumentType;
  idDocumentNumber: string;
  /** ISO 3166-1 alpha-2. Required for a passport; EG (or omitted) for a national ID. */
  nationality?: string;
  /** Required for a passport; ignored for a national ID. `YYYY-MM-DD` or a Date. */
  birthDate?: Date | string;
}

/** Validated and normalized, ready to store. */
export interface IdentityDocument {
  idDocumentType: IdDocumentType;
  idDocumentNumber: string;
  nationality: string;
  /** UTC midnight of the calendar date. */
  birthDate: Date;
}

export const MAX_AGE = 120;
const PASSPORT = /^[A-Z0-9]{5,20}$/;

/** Field errors for a document, or the normalized document. */
export function checkIdentityDocument(
  input: IdentityDocumentInput,
  today: Date = egyptToday(),
): { document: IdentityDocument } | { fields: FieldError[] } {
  const type = input.idDocumentType;
  if (type === 'national_id') {
    const fields: FieldError[] = [];
    const parsed = parseEgyptianNationalId(input.idDocumentNumber ?? '', today);
    if (!parsed) {
      fields.push({
        field: 'idDocumentNumber',
        code: FieldErrorCode.INVALID_NATIONAL_ID,
      });
    }
    const nationality = normalizeNationality(input.nationality);
    if (nationality !== null && nationality !== 'EG') {
      fields.push({
        field: 'nationality',
        code: FieldErrorCode.INVALID_NATIONALITY,
      });
    }
    // A birth date sent with a national ID is ignored: the ID carries it.
    if (fields.length || !parsed) return { fields };
    return {
      document: {
        idDocumentType: 'national_id',
        idDocumentNumber: parsed.value,
        nationality: 'EG',
        birthDate: parsed.birthDate,
      },
    };
  }

  if (type === 'passport') {
    const fields: FieldError[] = [];
    const number = normalizePassportNumber(input.idDocumentNumber ?? '');
    if (!PASSPORT.test(number)) {
      fields.push({
        field: 'idDocumentNumber',
        code: FieldErrorCode.INVALID_PASSPORT_NUMBER,
        params: { min: 5, max: 20 },
      });
    }
    const nationality = normalizeNationality(input.nationality);
    if (!nationality || !ISO_COUNTRIES.has(nationality)) {
      fields.push({
        field: 'nationality',
        code: FieldErrorCode.INVALID_NATIONALITY,
      });
    }
    const birth = checkBirthDate(input.birthDate, today);
    if ('field' in birth) fields.push(birth.field);
    if (fields.length || !nationality || !('date' in birth)) return { fields };
    return {
      document: {
        idDocumentType: 'passport',
        idDocumentNumber: number,
        nationality,
        birthDate: birth.date,
      },
    };
  }

  return {
    fields: [
      {
        field: 'idDocumentType',
        code: FieldErrorCode.INVALID_VALUE,
        params: { allowed: ['national_id', 'passport'] },
      },
    ],
  };
}

/** The document, or a VALIDATION_FAILED with its field errors. */
export function parseIdentityDocument(
  input: IdentityDocumentInput,
  today?: Date,
): IdentityDocument {
  const result = checkIdentityDocument(input, today);
  if ('fields' in result) throw invalidDocument(result.fields);
  return result.document;
}

export function invalidDocument(fields: FieldError[]) {
  return appError.badRequest(
    ErrorCode.VALIDATION_FAILED,
    'Invalid identity document',
    { fields },
  );
}

/** Trim, uppercase, no spaces. */
export function normalizePassportNumber(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

function normalizeNationality(raw: string | undefined): string | null {
  const value = (raw ?? '').trim().toUpperCase();
  return value ? value : null;
}

/**
 * A real calendar date, not in the future, at most MAX_AGE years ago.
 * Accepts a Date or `YYYY-MM-DD`.
 */
export function checkBirthDate(
  raw: Date | string | undefined | null,
  today: Date = egyptToday(),
): { date: Date } | { field: FieldError } {
  if (raw === undefined || raw === null || raw === '') {
    return {
      field: { field: 'birthDate', code: FieldErrorCode.BIRTH_DATE_REQUIRED },
    };
  }
  const invalid = {
    field: {
      field: 'birthDate',
      code: FieldErrorCode.INVALID_BIRTH_DATE,
      params: { maxAge: MAX_AGE },
    },
  };
  let date: Date;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return invalid;
    date = new Date(
      Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate()),
    );
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!m) return invalid;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    date = new Date(Date.UTC(y, mo - 1, d));
    if (
      date.getUTCFullYear() !== y ||
      date.getUTCMonth() !== mo - 1 ||
      date.getUTCDate() !== d
    ) {
      return invalid;
    }
  }
  if (date > today || ageOn(date, today) > MAX_AGE) return invalid;
  return { date };
}
