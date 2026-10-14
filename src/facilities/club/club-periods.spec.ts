import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import {
  activeOn,
  activeUntil,
  addMonths,
  nextStart,
  periodEnd,
  type PaidPeriod,
} from './club-periods';

const p = (startsOn: string, endsOn: string, reversed = false): PaidPeriod => ({
  startsOn,
  endsOn,
  reversed,
});

describe('a membership’s periods (ADR 0044)', () => {
  it('a month later is the same day of the month, or the last day of a shorter one', () => {
    expect(addMonths('2031-01-15', 1)).toBe('2031-02-15');
    expect(addMonths('2031-01-31', 1)).toBe('2031-02-28');
    expect(addMonths('2032-01-31', 1)).toBe('2032-02-29');
    expect(addMonths('2031-11-30', 3)).toBe('2032-02-29');
    expect(addMonths('2031-12-31', 12)).toBe('2032-12-31');
  });

  it('a plan’s period: months, or days', () => {
    expect(
      periodEnd('2031-01-10', { durationKind: 'monthly', durationDays: null }),
    ).toBe('2031-02-10');
    expect(
      periodEnd('2031-01-10', {
        durationKind: 'quarterly',
        durationDays: null,
      }),
    ).toBe('2031-04-10');
    expect(
      periodEnd('2031-01-10', { durationKind: 'annual', durationDays: null }),
    ).toBe('2032-01-10');
    expect(
      periodEnd('2031-01-10', { durationKind: 'custom', durationDays: 45 }),
    ).toBe('2031-02-24');
  });

  it('active on a day a period not reversed covers; the end is excluded', () => {
    const periods = [p('2031-01-10', '2031-02-10')];
    expect(activeOn(periods, '2031-01-10')).toBe(true);
    expect(activeOn(periods, '2031-02-09')).toBe(true);
    expect(activeOn(periods, '2031-02-10')).toBe(false);
    expect(activeOn([p('2031-01-10', '2031-02-10', true)], '2031-01-20')).toBe(
      false,
    );
  });

  it('a new period starts the day it was paid, or where the last period paid for ends', () => {
    expect(nextStart([], '2031-01-10')).toBe('2031-01-10');
    const one = [p('2031-01-10', '2031-02-10')];
    expect(nextStart(one, '2031-01-25')).toBe('2031-02-10');
    // Chained twice: paid while two periods were ahead.
    expect(
      nextStart([...one, p('2031-02-10', '2031-03-10')], '2031-01-25'),
    ).toBe('2031-03-10');
    // After it lapsed: from the day paid.
    expect(nextStart(one, '2031-02-20')).toBe('2031-02-20');
    // Recorded late, paid before a period that already started: after it.
    expect(nextStart(one, '2031-01-07')).toBe('2031-02-10');
    // A reversed period covers nothing.
    expect(nextStart([p('2031-01-10', '2031-02-10', true)], '2031-01-25')).toBe(
      '2031-01-25',
    );
  });

  it('active until the end of the run that covers the day; a reversal in the middle leaves a gap', () => {
    const periods = [
      p('2031-01-10', '2031-02-10'),
      p('2031-02-10', '2031-03-10'),
      p('2031-03-10', '2031-04-10'),
    ];
    expect(activeUntil(periods, '2031-01-20')).toBe('2031-04-10');
    expect(activeUntil(periods, '2031-04-10')).toBeNull();
    const gap = [periods[0], { ...periods[1], reversed: true }, periods[2]];
    expect(activeUntil(gap, '2031-01-20')).toBe('2031-02-10');
    expect(activeOn(gap, '2031-02-20')).toBe(false);
    expect(activeUntil(gap, '2031-03-20')).toBe('2031-04-10');
  });

  it('the reversal reasons are the CHECK’s and the dashboards’', () => {
    const repo = join(__dirname, '../../..');
    const migration = readFileSync(
      join(repo, 'prisma/migrations/20261022090500_club/migration.sql'),
      'utf8',
    );
    const dashboards = readFileSync(
      join(repo, 'packages/api/src/reasons.ts'),
      'utf8',
    );
    const quoted = REASON_CODES.clubPaymentReverse
      .map((c) => `'${c}'`)
      .join(', ');
    expect(migration).toContain(`"reason_code" IN (${quoted})`);
    expect(dashboards).toContain(`clubPaymentReverse: [${quoted}]`);
  });
});
