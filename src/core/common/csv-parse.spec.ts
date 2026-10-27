import { CsvRefused, parseCsv } from './csv-parse';
import { toCsv } from './csv';

const csv = (s: string) => Buffer.from(s, 'utf8');
const refused = (
  s: string | Buffer,
  limits?: Parameters<typeof parseCsv>[1],
) => {
  try {
    parseCsv(typeof s === 'string' ? csv(s) : s, limits);
  } catch (e) {
    if (e instanceof CsvRefused) return { problem: e.problem, line: e.line };
    throw e;
  }
  throw new Error('not refused');
};

describe('CSV import (ADR 0064)', () => {
  it('reads a header and rows, BOM stripped, CRLF or LF, names lowercased', () => {
    expect(parseCsv(csv('﻿Code, Name \r\nA-1,Pump\nA-2,برج\r\n'))).toEqual({
      header: ['code', 'name'],
      rows: [
        { line: 2, cells: ['A-1', 'Pump'] },
        { line: 3, cells: ['A-2', 'برج'] },
      ],
    });
  });

  it('keeps quoted commas, doubled quotes and line breaks; counts lines right', () => {
    const out = parseCsv(csv('a,b\n"x, ""y""","line\nbreak"\nlast,1'));
    expect(out.rows).toEqual([
      { line: 2, cells: ['x, "y"', 'line\nbreak'] },
      { line: 4, cells: ['last', '1'] },
    ]);
  });

  it('reads back what toCsv writes, defused cells included', () => {
    const written = toCsv(
      [
        { header: 'code', kind: 'text' },
        { header: 'note', kind: 'text' },
      ],
      [['=1+1', 'a "b", c']],
    );
    expect(parseCsv(written).rows[0].cells).toEqual(["'=1+1", 'a "b", c']);
  });

  it('skips blank lines', () => {
    expect(parseCsv(csv('a\n\n1\n\n')).rows).toEqual([
      { line: 3, cells: ['1'] },
    ]);
  });

  it('refuses what is not a clean sheet, with the line and never the text', () => {
    expect(refused(Buffer.from([0x61, 0x0a, 0xff, 0xfe]))).toEqual({
      problem: 'not_utf8',
      line: null,
    });
    expect(refused('a\n\u0000')).toEqual({
      problem: 'control_character',
      line: 2,
    });
    expect(refused('a\n"open')).toEqual({
      problem: 'unterminated_quote',
      line: 2,
    });
    expect(refused('a\nx"y')).toEqual({ problem: 'stray_quote', line: 2 });
    expect(refused('a\n"x"y')).toEqual({ problem: 'stray_quote', line: 2 });
    expect(refused('')).toEqual({ problem: 'empty', line: null });
    expect(refused('\n\n')).toEqual({ problem: 'empty', line: null });
    expect(refused('a,A\n1,2')).toEqual({
      problem: 'duplicate_header',
      line: 1,
    });
    expect(refused('a,b\n1,2\n3')).toEqual({ problem: 'ragged_row', line: 3 });
  });

  it('refuses a file over its limits', () => {
    const limits = { maxBytes: 64, maxRows: 2 };
    expect(refused('a\n1\n2\n3', limits)).toEqual({
      problem: 'too_many_rows',
      line: 4,
    });
    expect(refused(`a\n${'x'.repeat(64)}`, limits)).toEqual({
      problem: 'too_large',
      line: null,
    });
  });
});
