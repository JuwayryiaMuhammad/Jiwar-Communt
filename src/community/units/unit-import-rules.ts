import { $Enums, type OccupancyType, type UnitType } from '@prisma/client';
import type { ParsedCsv } from '../../core/common/csv-parse';
import { FieldErrorCode } from '../../core/common/errors';
import { checkIdentityDocument } from '../../core/common/identity-document';
import { normalizeEmail, normalizePhone } from '../../core/auth/identifier';
import { BUILDING_NAME_LENGTH } from './buildings.service';
import { AREA } from './dto/update-unit.dto';

/**
 * Sheets of the unit register (ADR 0072), as asset sheets are (ADR 0064):
 * a header naming the columns, one row per unit or per resident's place.
 * Empty cells are absent. A problem says where and what, never the cell.
 */
export const UNIT_IMPORT_KINDS = ['units', 'residents'] as const;
export type UnitImportKind = (typeof UNIT_IMPORT_KINDS)[number];

/** Rows a sheet may hold: a residents sheet creates accounts, so fewer. */
export const MAX_ROWS: Record<UnitImportKind, number> = {
  units: 2000,
  residents: 300,
};

export const UNIT_COLUMNS = {
  required: ['code'],
  optional: ['building', 'floor', 'unit_type', 'area_sqm'],
} as const;

export const RESIDENT_COLUMNS = {
  required: [
    'full_name',
    'phone',
    'email',
    'id_document_type',
    'id_document_number',
    'unit',
    'occupancy_type',
  ],
  optional: ['nationality', 'birth_date', 'resides', 'preferred_locale'],
} as const;

export const MAX_IMPORT_PROBLEMS = 100;
const CODE_LENGTH = { min: 1, max: 32 };
const NAME_LENGTH = { min: 2, max: 200 };
const FLOOR = { min: -5, max: 200 };

export interface ImportProblem {
  line: number;
  field: string;
  code: string;
}

export interface UnitRow {
  line: number;
  code: string;
  building: string | null;
  floor: number | null;
  unitType: UnitType | null;
  areaSqm: string | null;
}

export interface ResidentRow {
  line: number;
  fullName: string;
  phone: string;
  email: string;
  idDocumentType: 'national_id' | 'passport';
  idDocumentNumber: string;
  nationality?: string;
  birthDate?: string;
  unitId: string;
  occupancyType: OccupancyType;
  resides?: boolean;
  preferredLocale?: 'ar' | 'en';
}

/** What a units sheet is checked against: the codes the compound has. */
export interface UnitLookups {
  existingCodes: ReadonlySet<string>;
}

/** What a residents sheet is checked against. */
export interface ResidentLookups {
  /** Units by code. */
  units: ReadonlyMap<string, string>;
  /** Emails and phones a resident of the compound has already. */
  takenEmails: ReadonlySet<string>;
  takenPhones: ReadonlySet<string>;
}

/** The column's values, trimmed, empty ones left out. */
export function columnValues(sheet: ParsedCsv, name: string): string[] {
  const i = sheet.header.indexOf(name);
  return i < 0
    ? []
    : sheet.rows.map((r) => r.cells[i].trim()).filter((v) => v !== '');
}

function headerProblems(
  sheet: ParsedCsv,
  columns: { required: readonly string[]; optional: readonly string[] },
): ImportProblem[] {
  const all = [...columns.required, ...columns.optional];
  const problems: ImportProblem[] = [];
  for (const name of sheet.header)
    if (!all.includes(name))
      problems.push({
        line: 1,
        field: name,
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
  for (const name of columns.required)
    if (!sheet.header.includes(name))
      problems.push({
        line: 1,
        field: name,
        code: FieldErrorCode.FIELD_REQUIRED,
      });
  return problems;
}

/** A row's reader: cells by column name, and where its problems go. */
function rowReader(
  sheet: ParsedCsv,
  line: number,
  cells: string[],
  problems: ImportProblem[],
) {
  const get = (name: string): string | undefined => {
    const i = sheet.header.indexOf(name);
    const v = i < 0 ? '' : cells[i].trim();
    return v === '' ? undefined : v;
  };
  const fail = (field: string, code: string) =>
    problems.push({ line, field, code });
  const text = (
    name: string,
    limits: { min: number; max: number },
    required = false,
  ): string | null => {
    const v = get(name);
    if (v === undefined) {
      if (required) fail(name, FieldErrorCode.FIELD_REQUIRED);
      return null;
    }
    if (v.length < limits.min || v.length > limits.max) {
      fail(name, FieldErrorCode.INVALID_LENGTH);
      return null;
    }
    return v;
  };
  const oneOf = <T extends string>(
    name: string,
    allowed: readonly T[],
    required = false,
  ): T | null => {
    const v = get(name);
    if (v === undefined) {
      if (required) fail(name, FieldErrorCode.FIELD_REQUIRED);
      return null;
    }
    if (!(allowed as readonly string[]).includes(v)) {
      fail(name, FieldErrorCode.INVALID_VALUE);
      return null;
    }
    return v as T;
  };
  return { get, fail, text, oneOf };
}

/** A units sheet, whole; rows come out only when nothing is wrong. */
export function checkUnitSheet(
  sheet: ParsedCsv,
  l: UnitLookups,
): { rows: UnitRow[]; problems: ImportProblem[] } {
  const problems = headerProblems(sheet, UNIT_COLUMNS);
  if (problems.length) return { rows: [], problems };
  const rows: UnitRow[] = [];
  const seen = new Set<string>();
  for (const { line, cells } of sheet.rows) {
    const r = rowReader(sheet, line, cells, problems);
    const before = problems.length;
    const code = r.text('code', CODE_LENGTH, true);
    if (code !== null && (seen.has(code) || l.existingCodes.has(code)))
      r.fail('code', FieldErrorCode.DUPLICATE_VALUE);
    if (code !== null) seen.add(code);
    const building = r.text('building', BUILDING_NAME_LENGTH);
    const floorText = r.get('floor');
    let floor: number | null = null;
    if (floorText !== undefined) {
      const n = Number(floorText);
      if (!/^-?\d+$/.test(floorText) || n < FLOOR.min || n > FLOOR.max)
        r.fail('floor', FieldErrorCode.INVALID_NUMBER);
      else floor = n;
    }
    const unitType = r.oneOf('unit_type', Object.values($Enums.UnitType));
    const area = r.get('area_sqm');
    if (area !== undefined && (!AREA.test(area) || Number(area) <= 0))
      r.fail('area_sqm', FieldErrorCode.INVALID_NUMBER);
    if (problems.length === before && code !== null)
      rows.push({
        line,
        code,
        building,
        floor,
        unitType,
        areaSqm: area ?? null,
      });
  }
  return { rows: problems.length ? [] : rows, problems };
}

/** Where the identity document's field errors show in the sheet. */
const DOCUMENT_COLUMNS: Record<string, string> = {
  idDocumentType: 'id_document_type',
  idDocumentNumber: 'id_document_number',
  nationality: 'nationality',
  birthDate: 'birth_date',
};

/**
 * A residents sheet, whole: one row a person and the unit they hold a
 * place in (a second unit is added from the resident's page). An email or
 * a phone appears once in the sheet and is no resident's of the compound
 * already; the unit is one of the compound's.
 */
export function checkResidentSheet(
  sheet: ParsedCsv,
  l: ResidentLookups,
): { rows: ResidentRow[]; problems: ImportProblem[] } {
  const problems = headerProblems(sheet, RESIDENT_COLUMNS);
  if (problems.length) return { rows: [], problems };
  const rows: ResidentRow[] = [];
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const { line, cells } of sheet.rows) {
    const r = rowReader(sheet, line, cells, problems);
    const before = problems.length;
    const fullName = r.text('full_name', NAME_LENGTH, true);
    const contact = (
      name: 'phone' | 'email',
      normalize: (raw: string) => string | null,
      seen: Set<string>,
      taken: ReadonlySet<string>,
      invalid: string,
    ): string | null => {
      const raw = r.get(name);
      if (raw === undefined) {
        r.fail(name, FieldErrorCode.FIELD_REQUIRED);
        return null;
      }
      const value = normalize(raw);
      if (value === null) {
        r.fail(name, invalid);
        return null;
      }
      if (seen.has(value) || taken.has(value)) {
        r.fail(name, FieldErrorCode.DUPLICATE_VALUE);
        return null;
      }
      seen.add(value);
      return value;
    };
    const phone = contact(
      'phone',
      normalizePhone,
      phones,
      l.takenPhones,
      FieldErrorCode.INVALID_PHONE,
    );
    const email = contact(
      'email',
      normalizeEmail,
      emails,
      l.takenEmails,
      FieldErrorCode.INVALID_EMAIL,
    );
    const idDocumentType = r.oneOf(
      'id_document_type',
      ['national_id', 'passport'] as const,
      true,
    );
    const idDocumentNumber = r.get('id_document_number');
    if (idDocumentNumber === undefined)
      r.fail('id_document_number', FieldErrorCode.FIELD_REQUIRED);
    const nationality = r.get('nationality');
    const birthDate = r.get('birth_date');
    if (idDocumentType !== null && idDocumentNumber !== undefined) {
      const checked = checkIdentityDocument({
        idDocumentType,
        idDocumentNumber,
        nationality,
        birthDate,
      });
      if ('fields' in checked)
        for (const f of checked.fields)
          r.fail(DOCUMENT_COLUMNS[f.field] ?? f.field, f.code);
    }
    const unitCode = r.get('unit');
    const unitId = unitCode === undefined ? undefined : l.units.get(unitCode);
    if (unitCode === undefined) r.fail('unit', FieldErrorCode.FIELD_REQUIRED);
    else if (unitId === undefined)
      r.fail('unit', FieldErrorCode.UNIT_NOT_AVAILABLE);
    const occupancyType = r.oneOf(
      'occupancy_type',
      Object.values($Enums.OccupancyType),
      true,
    );
    const residesText = r.oneOf('resides', ['true', 'false'] as const);
    const resides = residesText === null ? undefined : residesText === 'true';
    // A tenant lives in the unit (ADR 0020).
    if (occupancyType === 'tenant' && resides === false)
      r.fail('resides', FieldErrorCode.INVALID_VALUE);
    const locale = r.oneOf('preferred_locale', ['ar', 'en'] as const);
    if (
      problems.length === before &&
      fullName !== null &&
      phone !== null &&
      email !== null &&
      idDocumentType !== null &&
      idDocumentNumber !== undefined &&
      unitId !== undefined &&
      occupancyType !== null
    )
      rows.push({
        line,
        fullName,
        phone,
        email,
        idDocumentType,
        idDocumentNumber,
        ...(nationality === undefined ? {} : { nationality }),
        ...(birthDate === undefined ? {} : { birthDate }),
        unitId,
        occupancyType,
        ...(resides === undefined ? {} : { resides }),
        ...(locale === null ? {} : { preferredLocale: locale }),
      });
  }
  return { rows: problems.length ? [] : rows, problems };
}
