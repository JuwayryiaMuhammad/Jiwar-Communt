import { Prisma } from '@prisma/client';
import { measureWindows, priceOn, spread } from './consumption-rules';

const D = (v: number | string) => new Prisma.Decimal(v);

describe('consumption (ADR 0066)', () => {
  it('spreads a period over its days, cut by month and by tariff', () => {
    const parts = spread(
      { from: '2026-11-25', to: '2026-12-05', use: D(100) },
      { from: '2026-11-28', to: '2026-12-31' },
      [
        { effectiveOn: '2026-01-01', pricePerUnit: D(1) },
        { effectiveOn: '2026-12-03', pricePerUnit: D(2) },
      ],
    );
    expect(
      parts.map((p) => [p.month, p.days, p.use.toString(), p.cost?.toString()]),
    ).toEqual([
      ['2026-11', 3, '30', '30'],
      ['2026-12', 2, '20', '20'],
      ['2026-12', 3, '30', '60'],
    ]);
  });

  it('leaves out what falls outside the window, and is unpriced before any tariff', () => {
    const parts = spread(
      { from: '2026-12-01', to: '2026-12-11', use: D(50) },
      { from: '2026-12-09', to: '2026-12-20' },
      [],
    );
    expect(parts.map((p) => [p.days, p.use.toString(), p.cost])).toEqual([
      [3, '15', null],
    ]);
    expect(
      priceOn(
        [{ effectiveOn: '2026-12-10', pricePerUnit: D(3) }],
        '2026-12-09',
      ),
    ).toBeNull();
  });

  it('reads a measure over whole weeks each side, complete once the after side has all its days', () => {
    expect(measureWindows('2026-12-01', 2, '2026-12-31')).toEqual({
      before: { from: '2026-11-17', to: '2026-11-30' },
      after: { from: '2026-12-01', to: '2026-12-14' },
      complete: true,
    });
    expect(measureWindows('2026-12-01', 2, '2026-12-05')).toEqual({
      before: { from: '2026-11-17', to: '2026-11-30' },
      after: { from: '2026-12-01', to: '2026-12-05' },
      complete: false,
    });
    expect(measureWindows('2026-12-10', 1, '2026-12-05').after).toBeNull();
  });
});
