import { strToU8, zipSync, type Zippable } from 'fflate';

// ============================================================================
// Workbooks (ADR 0086)
// ============================================================================
//
// The smallest SpreadsheetML a spreadsheet app opens: one sheet, a bold
// header row, text as inline strings (a cell that starts with `=` is text
// here, never a formula: a formula is an element of its own, which this
// never writes), figures as numbers. Written with fflate, already the
// exports' zip (ADR 0036), so no new dependency. Same input, same bytes:
// every entry carries one fixed time.

/** The first instant a zip can say: every entry's time, so bytes repeat. */
const ZIP_EPOCH = new Date(Date.UTC(1980, 0, 1));

/** Characters XML 1.0 cannot carry at all: dropped. */
// eslint-disable-next-line no-control-regex -- the C0 controls XML forbids
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

const escape = (s: string) =>
  s
    .replace(NOT_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** A column's letters: 0 → A, 25 → Z, 26 → AA. */
export function columnName(i: number): string {
  let n = i + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const NUMBER = /^-?\d+(\.\d+)?$/;

function cell(
  ref: string,
  value: string | null,
  kind: 'text' | 'number',
  style: number,
): string {
  if (value === null) return '';
  const s = style ? ` s="${style}"` : '';
  if (kind === 'number' && NUMBER.test(value))
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
}

/**
 * One sheet as an .xlsx: `header` the first row (bold), then `rows`, each
 * cell by its column's kind. A sheet name is cut to Excel's 31 characters
 * without the ones it refuses.
 */
export function toXlsx(
  sheetName: string,
  header: readonly string[],
  kinds: readonly ('text' | 'number')[],
  rows: readonly (readonly (string | null)[])[],
): Buffer {
  const name = escape(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  const lines = [
    `<row r="1">${header.map((h, i) => cell(`${columnName(i)}1`, h, 'text', 1)).join('')}</row>`,
    ...rows.map(
      (r, n) =>
        `<row r="${n + 2}">${r.map((v, i) => cell(`${columnName(i)}${n + 2}`, v, kinds[i] ?? 'text', 0)).join('')}</row>`,
    ),
  ];
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const ns = 'http://schemas.openxmlformats.org';
  const files: Zippable = {
    '[Content_Types].xml': strToU8(
      `${xml}<Types xmlns="${ns}/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      `${xml}<Relationships xmlns="${ns}/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      `${xml}<workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships">` +
        `<sheets><sheet name="${name || 'Report'}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `${xml}<Relationships xmlns="${ns}/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${ns}/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    ),
    'xl/styles.xml': strToU8(
      `${xml}<styleSheet xmlns="${ns}/spreadsheetml/2006/main">` +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '</styleSheet>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `${xml}<worksheet xmlns="${ns}/spreadsheetml/2006/main"><sheetData>${lines.join('')}</sheetData></worksheet>`,
    ),
  };
  return Buffer.from(zipSync(files, { level: 6, mtime: ZIP_EPOCH }));
}
