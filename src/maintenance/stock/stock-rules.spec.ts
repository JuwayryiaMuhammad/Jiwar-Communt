import { Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import {
  averageAfterReceipt,
  reorderState,
  STOCK_DELTA,
  STOCK_LEVEL,
  STOCK_UNITS,
} from './stock-rules';

const d = (v: string) => new Prisma.Decimal(v);
const migration = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261208090100_stock/migration.sql',
  ),
  'utf8',
).replace(/\s+/g, ' ');
const quoted = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

describe('the maintenance store’s rules (ADR 0065)', () => {
  it('a receipt moves the average cost by what was held and what came in', () => {
    // 10 at 5.00, then 30 at 9.00: (50 + 270) / 40 = 8.00.
    expect(
      averageAfterReceipt(d('10'), d('5'), d('30'), d('9')).toFixed(2),
    ).toBe('8.00');
    // To the piastre, half away from zero: (1×1 + 2×2) / 3 = 1.666… → 1.67.
    expect(averageAfterReceipt(d('1'), d('1'), d('2'), d('2')).toFixed(2)).toBe(
      '1.67',
    );
    // Nothing held, or no average yet: the receipt's cost.
    expect(
      averageAfterReceipt(d('0'), d('5'), d('3'), d('7.5')).toFixed(2),
    ).toBe('7.50');
    expect(averageAfterReceipt(d('4'), null, d('3'), d('2')).toFixed(2)).toBe(
      '2.00',
    );
    // A free receipt pulls it down.
    expect(
      averageAfterReceipt(d('1'), d('10'), d('1'), d('0')).toFixed(2),
    ).toBe('5.00');
  });

  it('the reorder warning is sent once on the fall and cleared on the rise', () => {
    expect(reorderState(d('5'), d('5'), false)).toBe('warn');
    expect(reorderState(d('4'), d('5'), true)).toBe('keep');
    expect(reorderState(d('6'), d('5'), true)).toBe('clear');
    expect(reorderState(d('6'), d('5'), false)).toBe('keep');
    expect(reorderState(d('0'), null, true)).toBe('clear');
    expect(reorderState(d('0'), null, false)).toBe('keep');
  });

  it('a delta is signed and never zero; a level zero or more', () => {
    for (const ok of ['1', '-2', '0.5', '-0.125'])
      expect(ok).toMatch(STOCK_DELTA);
    for (const bad of ['0', '-0', '0.000', '+1', '1.2345', ''])
      expect(bad).not.toMatch(STOCK_DELTA);
    for (const ok of ['0', '12', '3.250']) expect(ok).toMatch(STOCK_LEVEL);
    expect('-1').not.toMatch(STOCK_LEVEL);
  });

  it('the CHECKs repeat the units and the closed lists', () => {
    expect(migration).toContain(`"unit" IN (${quoted(STOCK_UNITS)})`);
    expect(migration).toContain(
      `"reason_code" IN (${quoted(REASON_CODES.stockAdjust)})`,
    );
    expect(migration).toContain(
      `"reason_code" IN (${quoted(REASON_CODES.partRequestDecline)})`,
    );
    expect(migration).toContain(
      `"reason_code" IN (${quoted(REASON_CODES.partRequestCancel)})`,
    );
  });
});
