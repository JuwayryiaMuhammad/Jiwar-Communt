/**
 * Reading a CSV the management uploads (ADR 0064): an asset list now,
 * meter readings later. RFC 4180 with what spreadsheet apps write: a
 * UTF-8 byte-order mark, CRLF or LF line ends, quoted cells with doubled
 * quotes and line breaks inside. Anything else is refused whole, with a
 * code and the row it stopped at, never a cell's text: the file is the
 * management's and may hold anything.
 */
export type CsvProblem =
  | 'too_large'
  | 'not_utf8'
  | 'control_character'
  | 'unterminated_quote'
  | 'stray_quote'
  | 'empty'
  | 'duplicate_header'
  | 'ragged_row'
  | 'too_many_rows';

export class CsvRefused extends Error {
  constructor(
    readonly problem: CsvProblem,
    /** The line it stopped at, the header being line 1; null for the file. */
    readonly line: number | null = null,
  ) {
    super(`CSV refused: ${problem}${line === null ? '' : ` at line ${line}`}`);
  }
}

export interface CsvLimits {
  maxBytes: number;
  /** Data rows, the header not counted. */
  maxRows: number;
}

export interface ParsedCsv {
  /** The header's names, trimmed and lowercased. */
  header: string[];
  /** Each data row with its line number (the header is line 1). */
  rows: { line: number; cells: string[] }[];
}

export const CSV_IMPORT_LIMITS: CsvLimits = {
  maxBytes: 1024 * 1024,
  maxRows: 2000,
};

// C0 controls other than tab, LF and CR, and DEL: never in a sheet's text.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function parseCsv(
  bytes: Buffer,
  limits: CsvLimits = CSV_IMPORT_LIMITS,
): ParsedCsv {
  if (bytes.length > limits.maxBytes) throw new CsvRefused('too_large');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CsvRefused('not_utf8');
  }
  if (text.startsWith('﻿')) text = text.slice(1);
  const records = split(text);
  const nonEmpty = records.filter(
    (r) => !(r.cells.length === 1 && r.cells[0] === ''),
  );
  if (nonEmpty.length === 0) throw new CsvRefused('empty');
  const [head, ...data] = nonEmpty;
  const header = head.cells.map((c) => c.trim().toLowerCase());
  if (new Set(header).size !== header.length)
    throw new CsvRefused('duplicate_header', head.line);
  if (data.length > limits.maxRows)
    throw new CsvRefused('too_many_rows', data[limits.maxRows].line);
  for (const row of data)
    if (row.cells.length !== header.length)
      throw new CsvRefused('ragged_row', row.line);
  return { header, rows: data };
}

/** Records with the line each starts on; quoted line breaks stay inside. */
function split(text: string): { line: number; cells: string[] }[] {
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let line = 1;
  let start = 1;
  let i = 0;
  let quoted = false;
  let afterQuote = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        afterQuote = true;
        i++;
        continue;
      }
      if (c === '\n') line++;
      if (CONTROL.test(c)) throw new CsvRefused('control_character', line);
      cell += c;
      i++;
      continue;
    }
    if (c === '"') {
      if (cell !== '' || afterQuote) throw new CsvRefused('stray_quote', line);
      quoted = true;
      i++;
      continue;
    }
    if (c === ',') {
      cells.push(cell);
      cell = '';
      afterQuote = false;
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      cells.push(cell);
      records.push({ line: start, cells });
      cells = [];
      cell = '';
      afterQuote = false;
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line++;
      start = line;
      continue;
    }
    if (afterQuote) throw new CsvRefused('stray_quote', line);
    if (CONTROL.test(c)) throw new CsvRefused('control_character', line);
    cell += c;
    i++;
  }
  if (quoted) throw new CsvRefused('unterminated_quote', start);
  if (cell !== '' || cells.length > 0) {
    cells.push(cell);
    records.push({ line: start, cells });
  }
  return records;
}
