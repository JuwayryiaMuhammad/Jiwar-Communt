import { Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import {
  COST_KINDS,
  costAmount,
  costTotals,
  MONEY,
  QUANTITY,
} from './cost-rules';

const migration = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261208090000_ticket_costs/migration.sql',
  ),
  'utf8',
);
const quoted = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');
const d = (v: string) => new Prisma.Decimal(v);

describe('a ticket’s costs (ADR 0065)', () => {
  it('an amount is quantity × unit amount to the piastre, half away from zero, as the CHECK rounds', () => {
    expect(costAmount('1.5', '10.25').toFixed(2)).toBe('15.38');
    expect(costAmount('0.333', '3').toFixed(2)).toBe('1.00');
    expect(costAmount('-2', '12.50').toFixed(2)).toBe('-25.00');
    expect(costAmount('-0.005', '1').toFixed(2)).toBe('-0.01');
    expect(migration).toContain(
      `"amount" = round("quantity" * "unit_amount", 2)`,
    );
  });

  it('quantities are positive with three decimals, money zero or more with two', () => {
    for (const ok of ['1', '0.5', '2.125', '999999999'])
      expect(ok).toMatch(QUANTITY);
    for (const bad of ['0', '0.000', '-1', '1.2345', '', '1e3'])
      expect(bad).not.toMatch(QUANTITY);
    for (const ok of ['0', '150', '150.5', '9999999.99'])
      expect(ok).toMatch(MONEY);
    for (const bad of ['-1', '1.234', '10000000', 'abc'])
      expect(bad).not.toMatch(MONEY);
  });

  it('totals leave voided entries out and net parts taken back', () => {
    const at = new Date();
    const totals = costTotals([
      { kind: 'labour', amount: d('100.00'), voidedAt: null },
      { kind: 'labour', amount: d('40.00'), voidedAt: at },
      { kind: 'part', amount: d('75.50'), voidedAt: null },
      { kind: 'part', amount: d('-25.25'), voidedAt: null },
      { kind: 'contractor', amount: d('300'), voidedAt: null },
    ]);
    expect(totals).toEqual({
      total: '450.25',
      labour: '100.00',
      contractor: '300.00',
      parts: '50.25',
      other: '0.00',
    });
  });

  it('the CHECKs repeat the kinds and the closed lists', () => {
    expect(migration).toContain(`"kind" IN (${quoted(COST_KINDS)})`);
    expect(migration).toContain(
      `"void_reason" IN (${quoted(REASON_CODES.ticketCostVoid)})`,
    );
    expect(migration.replace(/\s+/g, ' ')).toContain(
      `"action_code" IN (${quoted(REASON_CODES.ticketCompletionAction)})`,
    );
    expect(migration).toContain(
      `"dismiss_reason" IN (${quoted(REASON_CODES.quoteSuggestionDismiss)})`,
    );
  });
});
