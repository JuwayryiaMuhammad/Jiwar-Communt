import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import {
  isWorkDay,
  minuteOf,
  timeOf,
  workTimeRefusal,
  type WorkRules,
} from './permit-rules';

const read = (path: string) =>
  readFileSync(join(__dirname, '../../..', path), 'utf8');
const permits = read(
  'prisma/migrations/20261027090300_unit_permits/migration.sql',
).replace(/\s+/g, ' ');
const mirror = read('packages/api/src/reasons.ts');
const quoted = (list: readonly string[]) =>
  list.map((c) => `'${c}'`).join(', ');

describe('times of day', () => {
  it('HH:MM and minutes after midnight, both ways', () => {
    expect(minuteOf('00:00')).toBe(0);
    expect(minuteOf('09:30')).toBe(570);
    expect(minuteOf('23:59')).toBe(1439);
    for (const m of [0, 9, 60, 570, 1439]) expect(minuteOf(timeOf(m))).toBe(m);
    expect(timeOf(545)).toBe('09:05');
  });
});

describe('the compound’s work rules (ADR 0049)', () => {
  // Saturday to Thursday, 09:00–17:00, 2026-12-24 (a Thursday) off.
  const rules: WorkRules = {
    workDays: [0, 1, 2, 3, 4, 6],
    workFrom: 540,
    workTo: 1020,
    daysOff: ['2026-12-24'],
  };
  const cairo = (iso: string) => new Date(iso);

  it('a work day is a week day of work that is not a day off', () => {
    expect(isWorkDay(rules, '2026-12-23')).toBe(true); // Wednesday
    expect(isWorkDay(rules, '2026-12-24')).toBe(false); // the day off
    expect(isWorkDay(rules, '2026-12-25')).toBe(false); // Friday
    expect(isWorkDay(rules, '2026-12-26')).toBe(true); // Saturday
  });

  it('refuses a day off before the hours, and the hours on a work day', () => {
    // Cairo is UTC+2 in December.
    expect(
      workTimeRefusal(rules, cairo('2026-12-23T08:00:00Z'), 'Africa/Cairo'),
    ).toBeNull(); // 10:00
    expect(
      workTimeRefusal(rules, cairo('2026-12-23T06:59:00Z'), 'Africa/Cairo'),
    ).toBe('outside_work_hours'); // 08:59
    expect(
      workTimeRefusal(rules, cairo('2026-12-23T07:00:00Z'), 'Africa/Cairo'),
    ).toBeNull(); // 09:00, the first minute
    expect(
      workTimeRefusal(rules, cairo('2026-12-23T15:00:00Z'), 'Africa/Cairo'),
    ).toBe('outside_work_hours'); // 17:00: the hours end before it
    expect(
      workTimeRefusal(rules, cairo('2026-12-24T10:00:00Z'), 'Africa/Cairo'),
    ).toBe('day_off');
    expect(
      workTimeRefusal(rules, cairo('2026-12-25T10:00:00Z'), 'Africa/Cairo'),
    ).toBe('day_off');
    // 23:30 UTC on the 24th is 01:30 on Friday the 25th in Cairo.
    expect(
      workTimeRefusal(rules, cairo('2026-12-24T23:30:00Z'), 'Africa/Cairo'),
    ).toBe('day_off');
  });
});

describe('the permits’ lists (ADR 0049)', () => {
  it.each([
    'permitWorkType',
    'unitPermitReject',
    'unitPermitRevoke',
    'unitPermitCancel',
    'unitPermitSystemCancel',
    'permitWorkerRemove',
  ] as const)('%s matches its CHECK and the dashboards’ mirror', (list) => {
    const q = quoted(REASON_CODES[list]);
    expect(permits).toContain(`IN (${q})`);
    expect(mirror).toContain(`${list}: [${q}]`);
  });
});
