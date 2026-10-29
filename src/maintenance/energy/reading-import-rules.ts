import { Prisma } from '@prisma/client';
import type { ParsedCsv } from '../../core/common/csv-parse';
import { FieldErrorCode } from '../../core/common/errors';
import { addDays, isRealDate, type LocalDate } from '../schedules/local-dates';
import type { MeterMode } from './meter-rules';
import {
  neighbourProblem,
  READING_PAST_DAYS,
  READING_VALUE,
  type ReadingPoint,
} from './reading-rules';

/**
 * A sheet of meter readings (ADR 0066): one reading a row, a header naming
 * the columns — the meter's code, the compound's day and the value, and
 * whether the register was reset (`true`/`false`, `yes`/`no`, `1`/`0`).
 */
export const READING_COLUMNS = ['meter', 'read_on', 'value'] as const;
export const READING_OPTIONAL_COLUMNS = ['reset'] as const;
const COLUMNS: readonly string[] = [
  ...READING_COLUMNS,
  ...READING_OPTIONAL_COLUMNS,
];
const YES = ['true', 'yes', '1'];
const NO = ['', 'false', 'no', '0'];

/** Problems an import keeps; the count goes on. */
export const MAX_READING_PROBLEMS = 100;

/** A problem: where and what, never the cell's text. */
export interface ReadingProblem {
  line: number;
  field: string;
  code: string;
}

export interface SheetReading {
  line: number;
  meterCode: string;
  readOn: LocalDate;
  value: Prisma.Decimal;
  reset: boolean;
}

/** A meter a sheet names, read under the import's locks. */
export interface SheetMeter {
  id: string;
  active: boolean;
  mode: MeterMode;
  /** Its live readings around the sheet's days, oldest first. */
  live: readonly (ReadingPoint & { id: string })[];
}

/** The meter codes a sheet names. */
export function sheetMeterCodes(sheet: ParsedCsv): string[] {
  const col = sheet.header.indexOf('meter');
  if (col < 0) return [];
  return [
    ...new Set(
      sheet.rows.map((r) => r.cells[col].trim()).filter((v) => v !== ''),
    ),
  ].sort();
}

/** Each row on its own: the columns, a day that exists in the window, a value. */
export function parseReadingSheet(
  sheet: ParsedCsv,
  today: LocalDate,
): { rows: SheetReading[]; problems: ReadingProblem[] } {
  const problems: ReadingProblem[] = [];
  for (const name of sheet.header)
    if (!COLUMNS.includes(name))
      problems.push({
        line: 1,
        field: name,
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
  for (const name of READING_COLUMNS)
    if (!sheet.header.includes(name))
      problems.push({
        line: 1,
        field: name,
        code: FieldErrorCode.FIELD_REQUIRED,
      });
  if (problems.length) return { rows: [], problems };
  const cell = (cells: string[], name: string) => {
    const i = sheet.header.indexOf(name);
    return i < 0 ? '' : cells[i].trim();
  };
  const rows: SheetReading[] = [];
  for (const { line, cells } of sheet.rows) {
    const meterCode = cell(cells, 'meter');
    const readOn = cell(cells, 'read_on');
    const value = cell(cells, 'value');
    const reset = cell(cells, 'reset').toLowerCase();
    const before = problems.length;
    if (meterCode === '')
      problems.push({
        line,
        field: 'meter',
        code: FieldErrorCode.FIELD_REQUIRED,
      });
    if (readOn === '')
      problems.push({
        line,
        field: 'read_on',
        code: FieldErrorCode.FIELD_REQUIRED,
      });
    else if (!isRealDate(readOn))
      problems.push({
        line,
        field: 'read_on',
        code: FieldErrorCode.INVALID_FORMAT,
      });
    else if (readOn > today || readOn < addDays(today, -READING_PAST_DAYS))
      problems.push({
        line,
        field: 'read_on',
        code: FieldErrorCode.INVALID_VALUE,
      });
    if (value === '')
      problems.push({
        line,
        field: 'value',
        code: FieldErrorCode.FIELD_REQUIRED,
      });
    else if (!READING_VALUE.test(value))
      problems.push({
        line,
        field: 'value',
        code: FieldErrorCode.INVALID_FORMAT,
      });
    if (!YES.includes(reset) && !NO.includes(reset))
      problems.push({
        line,
        field: 'reset',
        code: FieldErrorCode.INVALID_VALUE,
      });
    if (problems.length === before)
      rows.push({
        line,
        meterCode,
        readOn,
        value: new Prisma.Decimal(value),
        reset: YES.includes(reset),
      });
  }
  return { rows, problems };
}

/**
 * The rows against their meters and the meters' live readings: a meter in
 * service, one reading a meter and day (on the sheet and in the database),
 * and each cumulative register in order with the readings on both sides —
 * the sheet's own rows among them — as one entered by hand would be.
 */
export function checkAgainstMeters(
  rows: readonly SheetReading[],
  meters: ReadonlyMap<string, SheetMeter>,
): ReadingProblem[] {
  const problems: ReadingProblem[] = [];
  const byMeter = new Map<string, SheetReading[]>();
  for (const r of rows) {
    const m = meters.get(r.meterCode);
    if (!m || !m.active) {
      problems.push({
        line: r.line,
        field: 'meter',
        code: FieldErrorCode.METER_NOT_AVAILABLE,
      });
      continue;
    }
    byMeter.set(r.meterCode, [...(byMeter.get(r.meterCode) ?? []), r]);
  }
  for (const [code, sheetRows] of byMeter) {
    const m = meters.get(code)!;
    const taken = new Set(m.live.map((p) => p.readOn));
    const seen = new Set<string>();
    const kept: SheetReading[] = [];
    for (const r of sheetRows) {
      if (seen.has(r.readOn))
        problems.push({
          line: r.line,
          field: 'read_on',
          code: FieldErrorCode.DUPLICATE_VALUE,
        });
      else if (taken.has(r.readOn))
        problems.push({
          line: r.line,
          field: 'read_on',
          code: FieldErrorCode.READING_EXISTS,
        });
      else kept.push(r);
      seen.add(r.readOn);
    }
    const merged = [
      ...m.live.map((p) => ({ ...p, line: null as number | null })),
      ...kept.map((r) => ({ ...r, line: r.line })),
    ].sort((a, b) => (a.readOn < b.readOn ? -1 : a.readOn > b.readOn ? 1 : 0));
    merged.forEach((p, i) => {
      if (p.line === null) return;
      const problem = neighbourProblem(
        m.mode,
        p,
        merged[i - 1] ?? null,
        merged[i + 1] ?? null,
      );
      if (problem)
        problems.push({
          line: p.line,
          field: 'value',
          code: FieldErrorCode[problem.code],
        });
    });
  }
  return problems.sort((a, b) => a.line - b.line);
}
