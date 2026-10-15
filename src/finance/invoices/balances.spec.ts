import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import { money } from '../money';
import { statusOf, type Balance } from './balances';

const balance = (total: string, credited: string, paid: string): Balance => ({
  total: money(total),
  credited: money(credited),
  paid: money(paid),
  outstanding: money(total).sub(credited).sub(paid),
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

  it('the credit note reasons are the CHECK’s and the dashboards’', () => {
    const repo = join(__dirname, '../../..');
    const migration = readFileSync(
      join(repo, 'prisma/migrations/20261024090300_invoices/migration.sql'),
      'utf8',
    );
    const dashboards = readFileSync(
      join(repo, 'packages/api/src/reasons.ts'),
      'utf8',
    );
    const quoted = REASON_CODES.creditNote.map((c) => `'${c}'`).join(', ');
    expect(migration).toContain(`"reason_code" IN (${quoted})`);
    expect(dashboards).toContain(`creditNote: [${quoted}]`);
  });
});
