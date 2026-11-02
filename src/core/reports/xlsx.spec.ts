import { strFromU8, unzipSync } from 'fflate';
import { columnName, toXlsx } from './xlsx';

describe('workbooks (ADR 0086)', () => {
  const book = toXlsx(
    'Maintenance spend',
    ['Building', 'Spend'],
    ['text', 'number'],
    [
      ['=HYPERLINK("x")', '150.00'],
      ['مبنى <أ> & ب', null],
    ],
  );
  const files = unzipSync(new Uint8Array(book));
  const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);

  it('holds the parts a spreadsheet app opens', () => {
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    expect(strFromU8(files['xl/workbook.xml'])).toContain(
      'name="Maintenance spend"',
    );
  });

  it('a figure is a number, text an inline string, never a formula', () => {
    expect(sheet).toContain('<c r="B2"><v>150.00</v></c>');
    expect(sheet).toContain(
      '<t xml:space="preserve">=HYPERLINK(&quot;x&quot;)</t>',
    );
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('مبنى &lt;أ&gt; &amp; ب');
    // An empty cell is left out.
    expect(sheet).not.toContain('r="B3"');
  });

  it('same input, same bytes', () => {
    expect(
      toXlsx(
        'Maintenance spend',
        ['Building', 'Spend'],
        ['text', 'number'],
        [
          ['=HYPERLINK("x")', '150.00'],
          ['مبنى <أ> & ب', null],
        ],
      ).equals(book),
    ).toBe(true);
  });

  it('names columns as a spreadsheet does', () => {
    expect([0, 25, 26, 701, 702].map(columnName)).toEqual([
      'A',
      'Z',
      'AA',
      'ZZ',
      'AAA',
    ]);
  });
});
