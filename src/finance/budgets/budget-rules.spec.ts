import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import { BUDGET_CATEGORIES, fiscalWindow, fiscalYearOf } from './budget-rules';

const read = (path: string) =>
  readFileSync(join(__dirname, '../../..', path), 'utf8').replace(/\s+/g, ' ');
const quoted = (list: readonly string[]) =>
  list.map((c) => `'${c}'`).join(', ');

describe('the budget’s rules (ADR 0055)', () => {
  it('a fiscal year runs from the first of its month for a year', () => {
    expect(fiscalWindow(2027, 1)).toEqual({
      startsOn: '2027-01-01',
      endsOn: '2027-12-31',
    });
    expect(fiscalWindow(2027, 7)).toEqual({
      startsOn: '2027-07-01',
      endsOn: '2028-06-30',
    });
    expect(fiscalWindow(2027, 3)).toEqual({
      startsOn: '2027-03-01',
      endsOn: '2028-02-29',
    });
  });

  it('a day falls in the year named after its start', () => {
    expect(fiscalYearOf('2027-06-30', 7)).toBe(2026);
    expect(fiscalYearOf('2027-07-01', 7)).toBe(2027);
    expect(fiscalYearOf('2027-01-01', 1)).toBe(2027);
  });

  it('the categories and the void codes are the CHECKs’ and the mirror’s', () => {
    expect(
      read('prisma/migrations/20261102090500_budgets/migration.sql'),
    ).toContain(`"category" IN (${quoted(BUDGET_CATEGORIES)})`);
    expect(
      read('prisma/migrations/20261102090600_expenses/migration.sql'),
    ).toContain(`"void_reason_code" IN (${quoted(REASON_CODES.expenseVoid)})`);
    expect(read('packages/api/src/reasons.ts')).toContain(
      `expenseVoid: [${quoted(REASON_CODES.expenseVoid)}]`,
    );
  });
});
