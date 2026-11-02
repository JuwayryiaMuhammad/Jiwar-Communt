import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { ParsedCsv } from '../../core/common/csv-parse';
import { FieldErrorCode } from '../../core/common/errors';
import { isRealDate } from '../../core/common/validation/local-date';
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';

/** A signed amount of at most 10,000,000, not zero, two decimals at most. */
export const SIGNED_MONEY = /^-?(?!0+(\.0{1,2})?$)\d{1,8}(\.\d{1,2})?$/;
/** A count of cash: zero or more, up to 10,000,000, two decimals at most. */
export const CASH_COUNT = /^\d{1,8}(\.\d{1,2})?$/;
export const MAX_SIGNED = new Prisma.Decimal(10_000_000);

/** How far back a movement's day may be, as an office payment's. */
export const MOVEMENT_DAYS_BACK = 31;
/** How far ahead an investigation may be due. */
export const INVESTIGATION_MAX_DAYS = 60;
/** A cheque is cashed within six months of its date; post-dated up to a year. */
export const CHEQUE_STALE_DAYS = 180;
export const CHEQUE_AHEAD_DAYS = 366;
/** A statement reaches two years back. */
export const STATEMENT_DAYS_BACK = 730;
/** A valid statement import is applied within a day, or expires. */
export const STATEMENT_IMPORT_TTL_MS = 24 * 3_600_000;
/** The most problems an import keeps. */
export const MAX_PROBLEMS = 100;

export interface StatementProblem {
  line: number;
  field: string;
  code: string;
}

export interface StatementRow {
  lineNo: number;
  bookedOn: LocalDate;
  amount: Prisma.Decimal;
  reference: string | null;
  description: string | null;
  hash: string;
}

const REQUIRED = ['date', 'amount'] as const;

/**
 * A bank statement's sheet (ADR 0085): `date` (YYYY-MM-DD) and `amount`
 * (signed: money in is positive), with an optional `reference` and
 * `description`. Each row is checked whole; the problems name the line,
 * the column and a code, never the cell. Each line's hash binds the
 * account, its day, amount, reference and description and its place among
 * identical lines of the file, so the same file twice gives the same
 * hashes, and two identical lines of one file are two lines.
 */
export function checkStatement(
  sheet: ParsedCsv,
  accountId: string,
  today: LocalDate,
): { rows: StatementRow[]; problems: StatementProblem[] } {
  const problems: StatementProblem[] = [];
  const col = new Map(sheet.header.map((h, i) => [h, i]));
  for (const name of REQUIRED)
    if (!col.has(name))
      problems.push({
        line: 1,
        field: name,
        code: FieldErrorCode.FIELD_REQUIRED,
      });
  if (problems.length) return { rows: [], problems };
  const cell = (cells: string[], name: string) => {
    const i = col.get(name);
    const v = i === undefined ? '' : (cells[i] ?? '').trim();
    return v === '' ? null : v;
  };
  const earliest = addDays(today, -STATEMENT_DAYS_BACK);
  const rows: StatementRow[] = [];
  const seen = new Map<string, number>();
  for (const { line, cells } of sheet.rows) {
    const date = cell(cells, 'date');
    const amount = cell(cells, 'amount');
    const reference = cell(cells, 'reference');
    const description = cell(cells, 'description');
    const before = problems.length;
    if (!date || !isRealDate(date))
      problems.push({
        line,
        field: 'date',
        code: date
          ? FieldErrorCode.INVALID_FORMAT
          : FieldErrorCode.FIELD_REQUIRED,
      });
    else if (date > today || date < earliest)
      problems.push({
        line,
        field: 'date',
        code: FieldErrorCode.INVALID_VALUE,
      });
    if (!amount || !SIGNED_MONEY.test(amount))
      problems.push({
        line,
        field: 'amount',
        code: amount
          ? FieldErrorCode.INVALID_FORMAT
          : FieldErrorCode.FIELD_REQUIRED,
      });
    if (reference !== null && reference.length > 100)
      problems.push({
        line,
        field: 'reference',
        code: FieldErrorCode.INVALID_LENGTH,
      });
    if (description !== null && description.length > 200)
      problems.push({
        line,
        field: 'description',
        code: FieldErrorCode.INVALID_LENGTH,
      });
    if (problems.length > before) continue;
    const value = new Prisma.Decimal(amount!);
    const key = [
      accountId,
      date,
      value.toFixed(2),
      reference ?? '',
      description ?? '',
    ].join('\n');
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    rows.push({
      lineNo: line,
      bookedOn: date!,
      amount: value,
      reference,
      description,
      hash: createHash('sha256').update(`${key}\n${n}`).digest('hex'),
    });
  }
  return { rows, problems };
}

/** Two references are the same written either way round in case and space. */
export const sameReference = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
