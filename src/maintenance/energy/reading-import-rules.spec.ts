import { Prisma } from '@prisma/client';
import { parseCsv } from '../../core/common/csv-parse';
import {
  checkAgainstMeters,
  parseReadingSheet,
  sheetMeterCodes,
  type SheetMeter,
} from './reading-import-rules';

const csv = (lines: string[]) =>
  parseCsv(Buffer.from(lines.join('\n'), 'utf8'));
const TODAY = '2026-12-20';

describe('a sheet of meter readings (ADR 0066)', () => {
  it('reads each row on its own: a day that exists, in the window, a value, a reset', () => {
    const { rows, problems } = parseReadingSheet(
      csv([
        'meter,read_on,value,reset',
        'W1,2026-12-01,10,',
        'W1,2026-02-30,10,',
        'W1,2026-12-21,10,',
        'W1,2026-12-02,-1,',
        'W1,2026-12-03,11,maybe',
        ',2026-12-04,12,yes',
        'W1,2026-12-05,13,YES',
      ]),
      TODAY,
    );
    expect(rows.map((r) => [r.line, r.readOn, r.reset])).toEqual([
      [2, '2026-12-01', false],
      [8, '2026-12-05', true],
    ]);
    expect(problems).toEqual([
      { line: 3, field: 'read_on', code: 'INVALID_FORMAT' },
      { line: 4, field: 'read_on', code: 'INVALID_VALUE' },
      { line: 5, field: 'value', code: 'INVALID_FORMAT' },
      { line: 6, field: 'reset', code: 'INVALID_VALUE' },
      { line: 7, field: 'meter', code: 'FIELD_REQUIRED' },
    ]);
    expect(
      sheetMeterCodes(csv(['meter,read_on,value', 'B,1,1', 'A,1,1', 'B,2,2'])),
    ).toEqual(['A', 'B']);
  });

  it('checks rows against their meters and live readings, the sheet’s own rows among them', () => {
    const { rows } = parseReadingSheet(
      csv([
        'meter,read_on,value',
        'W1,2026-12-05,90',
        'W1,2026-12-08,155',
        'W1,2026-12-10,1',
        'W1,2026-12-12,200',
        'W1,2026-12-12,210',
        'GONE,2026-12-12,1',
      ]),
      TODAY,
    );
    const meters = new Map<string, SheetMeter>([
      [
        'W1',
        {
          id: 'm1',
          active: true,
          mode: 'cumulative',
          live: [
            {
              id: 'r1',
              readOn: '2026-12-01',
              value: new Prisma.Decimal(100),
              reset: false,
            },
            {
              id: 'r2',
              readOn: '2026-12-10',
              value: new Prisma.Decimal(150),
              reset: false,
            },
          ],
        },
      ],
    ]);
    expect(checkAgainstMeters(rows, meters)).toEqual([
      { line: 2, field: 'value', code: 'READING_BELOW_PREVIOUS' },
      { line: 3, field: 'value', code: 'READING_ABOVE_NEXT' },
      { line: 4, field: 'read_on', code: 'READING_EXISTS' },
      { line: 6, field: 'read_on', code: 'DUPLICATE_VALUE' },
      { line: 7, field: 'meter', code: 'METER_NOT_AVAILABLE' },
    ]);
  });
});
