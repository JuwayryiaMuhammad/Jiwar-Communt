import { Prisma } from '@prisma/client';
import {
  categoryByTrades,
  declarationOf,
  fiscalYearAround,
  fiscalYearEnd,
  quarterEnd,
  quarterFirst,
  quarterLabel,
  quarterOf,
  splitVat,
  vatOf,
  withholdingOf,
} from './tax-rules';

const d = (v: string) => new Prisma.Decimal(v);
const RATES = { supplies: '1.00', services: '3.00', professional: '5.00' };

describe('taxes (ADR 0093)', () => {
  it('a line’s VAT is its amount at the rate, to the piastre, half up', () => {
    expect(vatOf('1000.00', '14').toFixed(2)).toBe('140.00');
    expect(vatOf('0.25', '14').toFixed(2)).toBe('0.04');
    expect(vatOf('0.03', '14').toFixed(2)).toBe('0.00');
  });

  it('an instalment plan’s VAT is split by share, the last taking the rest', () => {
    const parts = splitVat(
      [d('400.00'), d('400.00'), d('340.00')],
      d('140.00'),
    );
    expect(parts.map((p) => p.vat.toFixed(2))).toEqual([
      '49.12',
      '49.12',
      '41.76',
    ]);
    expect(parts.reduce((s, p) => s.add(p.vat), d('0')).toFixed(2)).toBe(
      '140.00',
    );
    expect(parts[0].net.toFixed(2)).toBe('350.88');
    expect(splitVat([d('10')], d('0'))[0]).toEqual({
      net: d('10'),
      vat: d('0'),
    });
  });

  it('withholding: off, exempt or below the threshold withholds nothing; else the category’s rate on the subtotal', () => {
    const base = { base: '10000.00', rates: RATES, threshold: '300.00' };
    expect(
      withholdingOf({
        ...base,
        enabled: false,
        category: 'services',
      }).amount.toFixed(2),
    ).toBe('0.00');
    expect(
      withholdingOf({ ...base, enabled: true, category: 'exempt' }).category,
    ).toBeNull();
    expect(
      withholdingOf({
        ...base,
        base: '299.99',
        enabled: true,
        category: 'services',
      }).category,
    ).toBeNull();
    const w = withholdingOf({ ...base, enabled: true, category: 'services' });
    expect([w.amount.toFixed(2), w.rate.toFixed(2), w.category]).toEqual([
      '300.00',
      '3.00',
      'services',
    ]);
    expect(
      withholdingOf({
        ...base,
        enabled: true,
        category: 'professional',
      }).amount.toFixed(2),
    ).toBe('500.00');
    expect(
      withholdingOf({
        ...base,
        enabled: true,
        category: 'supplies',
      }).amount.toFixed(2),
    ).toBe('100.00');
  });

  it('a vendor’s category by its trades: professional, then supplies alone, else services', () => {
    expect(categoryByTrades(['professional', 'other'])).toBe('professional');
    expect(categoryByTrades(['supplies'])).toBe('supplies');
    expect(categoryByTrades(['supplies', 'cleaning'])).toBe('services');
    expect(categoryByTrades(['maintenance'])).toBe('services');
  });

  it('a declaration is due or carried forward, never both', () => {
    expect(
      declarationOf({
        output: d('1400'),
        input: d('300'),
        carriedIn: d('100'),
      }),
    ).toEqual({ netDue: d('1000'), carriedOut: d('0') });
    expect(
      declarationOf({ output: d('100'), input: d('300'), carriedIn: d('50') }),
    ).toEqual({ netDue: d('0'), carriedOut: d('250') });
    expect(
      declarationOf({ output: d('-20'), input: d('0'), carriedIn: d('0') }),
    ).toEqual({ netDue: d('0'), carriedOut: d('20') });
  });

  it('quarters are the calendar’s', () => {
    expect(quarterOf('2026-11-10')).toBe('2026-10-01');
    expect(quarterOf('2026-03-31')).toBe('2026-01-01');
    expect(quarterEnd('2026-10-01')).toBe('2026-12-31');
    expect(quarterEnd('2026-01-01')).toBe('2026-03-31');
    expect(quarterLabel('2026-07-01')).toBe('2026-Q3');
    expect(quarterFirst('2026-Q4')).toBe('2026-10-01');
  });

  it('a fiscal year runs from its start month', () => {
    expect(fiscalYearAround('2026-11-10', 1)).toEqual({
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
    });
    expect(fiscalYearAround('2026-03-10', 7)).toEqual({
      startsOn: '2025-07-01',
      endsOn: '2026-06-30',
    });
    expect(fiscalYearEnd('2024-03-01')).toBe('2025-02-28');
  });
});
