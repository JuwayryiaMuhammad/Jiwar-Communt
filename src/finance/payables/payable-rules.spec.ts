import { Prisma } from '@prisma/client';
import {
  fiscalMonth,
  lineTax,
  monthsFromQuarters,
  monthsOf,
  retentionOf,
} from './payable-rules';

const d = (v: string) => new Prisma.Decimal(v);

describe('payables’ rules (ADR 0089)', () => {
  it('a line’s tax is its amount at the code’s rate, to the piastre', () => {
    expect(lineTax('1000.00', 'zero')).toBe('0.00');
    expect(lineTax('1000.00', 'exempt')).toBe('0.00');
    expect(lineTax('1000.00', 'vat_14')).toBe('140.00');
    expect(lineTax('0.25', 'vat_14')).toBe('0.04');
  });

  it('a retention is the share of the gross, none without one', () => {
    expect(retentionOf('10000.00', '5')).toBe('500.00');
    expect(retentionOf('333.33', '10.00')).toBe('33.33');
    expect(retentionOf('100.00', null)).toBe('0.00');
  });

  it('a fiscal month counts from the year’s first month', () => {
    expect(fiscalMonth('2027-01-15', 1)).toBe(1);
    expect(fiscalMonth('2027-07-01', 7)).toBe(1);
    expect(fiscalMonth('2028-06-30', 7)).toBe(12);
  });

  it('a line with no months is split evenly, the piastres left on the last', () => {
    const m = monthsOf('1000.00', []);
    expect(m.map((x) => x.toFixed(2))).toEqual([
      ...Array.from({ length: 11 }, () => '83.33'),
      '83.37',
    ]);
    expect(m.reduce((a, x) => a.add(x), d('0')).toFixed(2)).toBe('1000.00');
  });

  it('quarters spread on their months add up to them', () => {
    const m = monthsFromQuarters(['100.00', '0', '50.00', '850.00']);
    expect(m).toHaveLength(12);
    expect(m.slice(0, 3).map((x) => x.toFixed(2))).toEqual([
      '33.33',
      '33.33',
      '33.34',
    ]);
    expect(m.reduce((a, x) => a.add(x), d('0')).toFixed(2)).toBe('1000.00');
  });
});
