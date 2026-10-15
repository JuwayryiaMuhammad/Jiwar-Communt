import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import { money } from '../money';
import { statusOf, type Balance } from './balances';

const balance = (
  total: string,
  credited: string,
  paid: string,
  rescheduled = false,
): Balance => ({
  total: money(total),
  credited: money(credited),
  paid: money(paid),
  outstanding: money(total).sub(credited).sub(paid),
  rescheduled,
});

describe('invoice status (ADR 0046)', () => {
  const today = '2026-10-15';

  it('owed before the due date: unpaid, or partially paid once something was paid', () => {
    expect(statusOf(balance('100', '0', '0'), '2026-10-15', today)).toBe(
      'unpaid',
    );
    expect(statusOf(balance('100', '30', '0'), '2026-10-20', today)).toBe(
      'unpaid',
    );
    expect(statusOf(balance('100', '0', '30'), '2026-10-20', today)).toBe(
      'partially_paid',
    );
  });

  it('owed after the due date (the compound’s day): overdue, paid in part or not', () => {
    expect(statusOf(balance('100', '0', '0'), '2026-10-14', today)).toBe(
      'overdue',
    );
    expect(statusOf(balance('100', '0', '99.99'), '2026-10-14', today)).toBe(
      'overdue',
    );
  });

  it('nothing owed: paid when anything was paid, credited when credit notes cover it all', () => {
    expect(statusOf(balance('100', '0', '100'), '2026-10-01', today)).toBe(
      'paid',
    );
    expect(statusOf(balance('100', '40', '60'), '2026-10-01', today)).toBe(
      'paid',
    );
    expect(statusOf(balance('100', '100', '0'), '2026-10-01', today)).toBe(
      'credited',
    );
  });

  it('closed by an instalment plan: rescheduled, even when part was paid first (ADR 0048)', () => {
    expect(
      statusOf(balance('100', '100', '0', true), '2026-10-01', today),
    ).toBe('rescheduled');
    expect(
      statusOf(balance('100', '60', '40', true), '2026-10-01', today),
    ).toBe('rescheduled');
    // Still owed (a plan never leaves that, but the status is the balance's).
    expect(statusOf(balance('100', '50', '0', true), '2026-10-20', today)).toBe(
      'unpaid',
    );
  });

  it('the credit note reasons — the staff’s and the system’s — are the latest CHECK’s and the dashboards’', () => {
    const repo = join(__dirname, '../../..');
    const migration = latestDefinition(repo, 'credit_notes_reason');
    const dashboards = readFileSync(
      join(repo, 'packages/api/src/reasons.ts'),
      'utf8',
    );
    const quote = (codes: readonly string[]) =>
      codes.map((c) => `'${c}'`).join(', ');
    expect(migration).toContain(
      `"reason_code" IN (${quote([...REASON_CODES.creditNote, ...REASON_CODES.creditNoteSystem])})`,
    );
    expect(dashboards).toContain(
      `creditNote: [${quote(REASON_CODES.creditNote)}]`,
    );
    expect(dashboards).toContain(
      `creditNoteSystem: [${quote(REASON_CODES.creditNoteSystem)}]`,
    );
  });
});

/** The last migration (in apply order) that adds `constraint`. */
function latestDefinition(repo: string, constraint: string): string {
  const dir = join(repo, 'prisma/migrations');
  const found = readdirSync(dir)
    .filter((d) => /^\d{14}_/.test(d))
    .sort()
    .map((d) => readFileSync(join(dir, d, 'migration.sql'), 'utf8'))
    .filter((sql) => sql.includes(`ADD CONSTRAINT "${constraint}"`));
  return found[found.length - 1];
}
