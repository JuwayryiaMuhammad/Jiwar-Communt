import { Prisma } from '@prisma/client';
import {
  expectedRange,
  meanRate,
  neighbourProblem,
  periods,
  spike,
  type ReadingPoint,
} from './reading-rules';

const D = (v: string | number) => new Prisma.Decimal(v);
const p = (readOn: string, value: number, reset = false): ReadingPoint => ({
  readOn,
  value: D(value),
  reset,
});

describe('meter readings (ADR 0066)', () => {
  it('a cumulative register is not below the reading before it, nor above the one after', () => {
    const before = p('2026-12-01', 100);
    const after = p('2026-12-20', 150);
    expect(
      neighbourProblem(
        'cumulative',
        { value: D(90), reset: false },
        before,
        after,
      ),
    ).toEqual({
      code: 'READING_BELOW_PREVIOUS',
      params: { previous: '100.0000' },
    });
    expect(
      neighbourProblem(
        'cumulative',
        { value: D(160), reset: false },
        before,
        after,
      ),
    ).toEqual({ code: 'READING_ABOVE_NEXT', params: { next: '150.0000' } });
    expect(
      neighbourProblem(
        'cumulative',
        { value: D(100), reset: false },
        before,
        after,
      ),
    ).toBeNull();
    expect(
      neighbourProblem(
        'cumulative',
        { value: D(150), reset: false },
        before,
        after,
      ),
    ).toBeNull();
  });

  it('a reset ends the check on its side; an interval meter keeps no order', () => {
    const before = p('2026-12-01', 100);
    expect(
      neighbourProblem(
        'cumulative',
        { value: D(3), reset: true },
        before,
        null,
      ),
    ).toBeNull();
    expect(
      neighbourProblem(
        'cumulative',
        { value: D(900), reset: false },
        before,
        p('2026-12-20', 3, true),
      ),
    ).toBeNull();
    expect(
      neighbourProblem(
        'interval',
        { value: D(1), reset: false },
        before,
        p('2026-12-20', 0),
      ),
    ).toBeNull();
  });

  it('periods: the climb times the multiplier, from zero after a reset; a day’s rate', () => {
    const ps = periods('cumulative', D(2), [
      p('2026-12-01', 100),
      p('2026-12-11', 150),
      p('2026-12-16', 5, true),
    ]);
    expect(
      ps.map((x) => [x.days, x.use.toString(), x.rate.toString()]),
    ).toEqual([
      [10, '100', '10'],
      [5, '10', '2'],
    ]);
    const iv = periods('interval', D(1), [
      p('2026-12-01', 7),
      p('2026-12-03', 8),
    ]);
    expect(iv.map((x) => x.use.toString())).toEqual(['8']);
  });

  it('a spike is above the mean before it times the factor, from three periods', () => {
    const steady = periods('cumulative', D(1), [
      p('2026-11-01', 1000),
      p('2026-11-11', 1100),
      p('2026-11-21', 1200),
      p('2026-12-01', 1300),
    ]);
    expect(meanRate(steady)!.toString()).toBe('10');
    expect(meanRate(steady.slice(0, 2))).toBeNull();
    const high = periods('cumulative', D(1), [
      p('2026-11-01', 1000),
      p('2026-11-11', 1100),
      p('2026-11-21', 1200),
      p('2026-12-01', 1300),
      p('2026-12-06', 1600),
    ]);
    const found = spike(high, 6, D(2))!;
    expect([found.rate.toString(), found.baseline.toString()]).toEqual([
      '60',
      '10',
    ]);
    expect(spike(high, 6, D(7))).toBeNull();
    expect(spike(steady, 6, D(2))).toBeNull();
  });

  it('the range a technician expects: the last reading, up to the mean’s days times the factor', () => {
    expect(
      expectedRange(
        'cumulative',
        D(1),
        p('2026-12-01', 1300),
        D(10),
        '2026-12-11',
        D(2),
      ),
    ).toEqual({ from: '1300.0000', to: '1500.0000' });
    expect(
      expectedRange(
        'interval',
        D(2),
        p('2026-12-01', 40),
        D(10),
        '2026-12-03',
        D(2),
      ),
    ).toEqual({ from: '0.0000', to: '20.0000' });
    expect(
      expectedRange(
        'cumulative',
        D(1),
        p('2026-12-01', 5),
        null,
        '2026-12-11',
        D(2),
      ),
    ).toEqual({ from: '5.0000', to: null });
    expect(
      expectedRange('cumulative', D(1), null, null, '2026-12-11', D(2)),
    ).toBeNull();
  });
});
