import { toCsv } from './csv';

const text = (b: Buffer) => b.toString('utf8');

describe('CSV export (ADR 0048)', () => {
  it('starts with a byte-order mark, ends lines with CRLF', () => {
    const out = text(
      toCsv(
        [
          { header: 'unit', kind: 'text' },
          { header: 'amount', kind: 'number' },
        ],
        [['A-101', '1500.00']],
      ),
    );
    expect(out).toBe('\uFEFFunit,amount\r\nA-101,1500.00\r\n');
  });

  it('quotes commas, quotes and line breaks; keeps Arabic as it is', () => {
    const out = text(
      toCsv(
        [{ header: 'building', kind: 'text' }],
        [['Tower, "B"'], ['line\nbreak'], ['برج النخيل']],
      ),
    );
    expect(out.split('\r\n').slice(1, 4)).toEqual([
      '"Tower, ""B"""',
      '"line\nbreak"',
      'برج النخيل',
    ]);
  });

  it('defuses a text cell a spreadsheet would run as a formula; numbers are left alone', () => {
    const out = text(
      toCsv(
        [
          { header: 'reference', kind: 'text' },
          { header: 'amount', kind: 'number' },
        ],
        [
          ['=HYPERLINK("x")', '-250.00'],
          ['+1', '0.00'],
          ['-2', '1.00'],
          ['@SUM(A1)', '2.00'],
          ['\tTAB', '3.00'],
        ],
      ),
    );
    expect(out.split('\r\n').slice(1, 6)).toEqual([
      `"'=HYPERLINK(""x"")",-250.00`,
      `'+1,0.00`,
      `'-2,1.00`,
      `'@SUM(A1),2.00`,
      `'\tTAB,3.00`,
    ]);
  });

  it('an empty cell for null', () => {
    expect(
      text(
        toCsv(
          [
            { header: 'a', kind: 'text' },
            { header: 'b', kind: 'number' },
          ],
          [[null, null]],
        ),
      ),
    ).toBe('\uFEFFa,b\r\n,\r\n');
  });
});
