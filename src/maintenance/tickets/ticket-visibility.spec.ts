import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RESIDENT_VISIBLE,
  residentParties,
  residentReporter,
  residentVisible,
  TICKET_ORIGINS,
} from './ticket-visibility';

type Row = { origin: string; unitId: string | null };

/** What the Prisma filter selects, evaluated as Postgres would. */
function selects(where: typeof RESIDENT_VISIBLE, row: Row): boolean {
  return (where.OR as Record<string, unknown>[]).some((branch) =>
    Object.entries(branch).every(([key, cond]) => {
      const value = row[key as keyof Row];
      if (cond !== null && typeof cond === 'object' && 'not' in cond)
        return value !== cond.not;
      return value === cond;
    }),
  );
}

describe('the resident side of tickets (ADR 0064)', () => {
  const rows: Row[] = TICKET_ORIGINS.flatMap((origin) => [
    { origin, unitId: 'unit-1' },
    { origin, unitId: null },
  ]);

  it('resident tickets, and a field ticket in a unit; never another work order', () => {
    expect(rows.filter(residentVisible)).toEqual([
      { origin: 'resident', unitId: 'unit-1' },
      { origin: 'resident', unitId: null },
      { origin: 'field', unitId: 'unit-1' },
    ]);
  });

  it('the filter and the check are one rule', () => {
    for (const row of rows)
      expect([row, selects(RESIDENT_VISIBLE, row)]).toEqual([
        row,
        residentVisible(row),
      ]);
  });

  it('a work order’s staff reporter and creator are never the resident side', () => {
    for (const origin of TICKET_ORIGINS) {
      const t = { origin, reporterId: 'r', createdById: 'c' };
      expect(residentReporter(t)).toBe(origin === 'resident' ? 'r' : null);
      expect(residentParties(t)).toEqual(
        origin === 'resident' ? ['r', 'c'] : [],
      );
    }
  });

  it('the origins are the CHECK’s', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261201090400_staff_work_orders/migration.sql',
      ),
      'utf8',
    );
    expect(sql).toContain(
      `CHECK ("origin" IN (${TICKET_ORIGINS.map((o) => `'${o}'`).join(', ')}))`,
    );
  });
});
