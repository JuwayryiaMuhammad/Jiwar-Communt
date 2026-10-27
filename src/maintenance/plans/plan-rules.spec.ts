import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import {
  afterDone,
  afterGeneration,
  firstDue,
  OCCURRENCE_STATUSES,
  onTime,
  opensBy,
  overdue,
  usageDue,
} from './plan-rules';

const sql = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261201090600_maintenance_plans/migration.sql',
  ),
  'utf8',
);
const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

describe('maintenance plan rules (ADR 0064)', () => {
  it('the closed lists are the CHECKs’', () => {
    expect(sql).toContain(`"reason_code" IN (${list(REASON_CODES.planSkip)})`);
    expect(sql).toContain(
      `"reason_code" IN (${list(REASON_CODES.planOccurrenceSystem)})`,
    );
    for (const s of OCCURRENCE_STATUSES)
      expect(sql).toContain(`"status" = '${s}'`);
  });

  it('a fixed series comes due on its own dates; a floating one from the day the work was done', () => {
    const fixed = {
      every: 3,
      unit: 'month' as const,
      anchorOn: '2026-01-15',
      basis: 'fixed' as const,
    };
    expect(firstDue(fixed, '2026-10-27')).toBe('2027-01-15');
    expect(firstDue(fixed, '2026-10-15')).toBe('2026-10-15');
    expect(afterGeneration(fixed, '2027-01-15')).toBe('2027-04-15');
    const floating = { ...fixed, basis: 'floating' as const };
    expect(firstDue(floating, '2026-10-27')).toBe('2026-10-27');
    expect(
      firstDue({ ...floating, anchorOn: '2026-12-01' }, '2026-10-27'),
    ).toBe('2026-12-01');
    expect(afterGeneration(floating, '2026-10-27')).toBeNull();
    expect(afterDone(floating, '2026-11-30')).toBe('2027-02-28');
  });

  it('opens `lead` days before; on time through the grace; overdue after it', () => {
    expect(opensBy('2026-11-03', 7, '2026-10-27')).toBe(true);
    expect(opensBy('2026-11-04', 7, '2026-10-27')).toBe(false);
    expect(onTime('2026-10-27', 3, '2026-10-30')).toBe(true);
    expect(onTime('2026-10-27', 3, '2026-10-31')).toBe(false);
    expect(overdue('2026-10-27', 3, '2026-10-30')).toBe(false);
    expect(overdue('2026-10-27', 3, '2026-10-31')).toBe(true);
  });

  it('a usage plan comes due when the metric grew by its interval', () => {
    expect(usageDue(1500, 1000, 500)).toBe(true);
    expect(usageDue(1499.9, 1000, 500)).toBe(false);
    expect(usageDue(500, null, 500)).toBe(true);
  });
});
