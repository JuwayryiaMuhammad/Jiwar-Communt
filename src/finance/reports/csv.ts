import { StreamableFile } from '@nestjs/common';
import { appError, ErrorCode } from '../../core/common/errors';

/** A column: free text (guarded against formulas) or a number we wrote. */
export interface CsvColumn {
  header: string;
  kind: 'text' | 'number';
}

const BOM = '\uFEFF';
/** What a spreadsheet would run as a formula at the start of a cell. */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: string | null, kind: CsvColumn['kind']): string {
  if (value === null) return '';
  // A text cell that a spreadsheet would read as a formula is defused with
  // a leading apostrophe; numbers are ours (amounts may be negative).
  const text =
    kind === 'text' && FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * RFC 4180 CSV (ADR 0048): a header row, CRLF line ends, quotes where
 * needed, and a UTF-8 byte-order mark so spreadsheet apps read Arabic
 * right.
 */
export function toCsv(
  columns: readonly CsvColumn[],
  rows: readonly (readonly (string | null)[])[],
): Buffer {
  const lines = [
    columns.map((c) => cell(c.header, 'text')).join(','),
    ...rows.map((r) => r.map((v, i) => cell(v, columns[i].kind)).join(',')),
  ];
  return Buffer.from(`${BOM}${lines.join('\r\n')}\r\n`, 'utf8');
}

/**
 * The CSV as a download. Its type and name travel with the stream, never
 * through `@Header`: Nest sets those before validation, so an error would
 * go out labelled as CSV.
 */
export function csvFile(name: string, body: Buffer): StreamableFile {
  return new StreamableFile(body, {
    type: 'text/csv; charset=utf-8',
    disposition: `attachment; filename="${name}"`,
    length: body.length,
  });
}

/**
 * How many rows one export may hold (ADR 0048): more answers
 * EXPORT_TOO_LARGE (narrow the period). An object, so a suite may lower it.
 */
export class ExportLimit {
  maxRows = 100_000;
}

export const exportTooLarge = (max: number) =>
  appError.unprocessable(
    ErrorCode.EXPORT_TOO_LARGE,
    'Too many rows for one export: narrow the period',
    { params: { max } },
  );
