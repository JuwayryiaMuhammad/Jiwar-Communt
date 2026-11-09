import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { REASON_CODES } from '../../core/common/reasons';
import { INBOX_TYPES } from '../../core/staff-inbox/staff-inbox';
import { COUNTER_ORDER } from '../counters';
import { parseLines } from './gl-entries.service';
import {
  GL_SOURCES,
  lastDay,
  monthsBetween,
  monthsToClose,
  nextMonth,
  normalBalance,
  rollUp,
  sideOf,
  totals,
} from './gl-rules';

const d = (v: string) => new Prisma.Decimal(v);
const migration = (name: string) =>
  readFileSync(
    join(__dirname, '../../../prisma/migrations', name, 'migration.sql'),
    'utf8',
  );
const quoted = (codes: readonly string[]) =>
  codes.map((c) => `'${c}'`).join(', ');

describe('the general ledger’s rules (ADR 0092)', () => {
  it('months: the next, the last day, a range, and what a close through one closes', () => {
    expect(nextMonth('2026-12-01')).toBe('2027-01-01');
    expect(lastDay('2028-02-10')).toBe('2028-02-29');
    expect(monthsBetween('2026-10-15', '2027-01-02')).toEqual([
      '2026-10-01',
      '2026-11-01',
      '2026-12-01',
      '2027-01-01',
    ]);
    // From the ledger's first entry, the closed ones aside.
    expect(
      monthsToClose('2026-10-01', '2026-07-20', new Set(['2026-08-01'])),
    ).toEqual(['2026-07-01', '2026-09-01', '2026-10-01']);
    // No entry before it: that month alone.
    expect(monthsToClose('2026-10-01', null, new Set())).toEqual([
      '2026-10-01',
    ]);
    expect(monthsToClose('2026-10-01', '2026-11-03', new Set())).toEqual([
      '2026-10-01',
    ]);
  });

  it('balances on the normal side; a trial balance’s side; sub-accounts roll up', () => {
    expect(normalBalance('asset', d('100'), d('30')).toFixed(2)).toBe('70.00');
    expect(normalBalance('revenue', d('100'), d('30')).toFixed(2)).toBe(
      '-70.00',
    );
    expect(sideOf(d('5'), d('8'))).toEqual({ debit: d('0'), credit: d('3') });
    const totalsOf = rollUp([
      { id: 'a', parentId: null, debit: d('1'), credit: d('0') },
      { id: 'b', parentId: 'a', debit: d('10'), credit: d('2') },
      { id: 'c', parentId: 'b', debit: d('0'), credit: d('4') },
    ]);
    expect(totalsOf.get('a')).toEqual({ debit: d('11'), credit: d('6') });
    expect(totalsOf.get('b')).toEqual({ debit: d('10'), credit: d('6') });
  });

  it('a manual entry: each line one side, balanced and not zero', () => {
    expect(totals([]).balanced).toBe(false);
    const lines = parseLines([
      { accountId: 'x', debit: '10.50' },
      { accountId: 'y', credit: '10.5' },
    ]);
    expect(totals(lines)).toMatchObject({ balanced: true });
    expect(() =>
      parseLines([
        { accountId: 'x', debit: '10' },
        { accountId: 'y', credit: '9' },
      ]),
    ).toThrow(/debits and the credits/);
    expect(() =>
      parseLines([
        { accountId: 'x', debit: '0' },
        { accountId: 'y', credit: '0' },
      ]),
    ).toThrow(/Invalid request/);
  });

  it('the last CHECKs name every inbox type and every counter, in their order', () => {
    const last = migration('20270615090400_gl_checks').replace(/\s+/g, ' ');
    expect(last.split(`"type" IN (${quoted(INBOX_TYPES)}))`)).toHaveLength(3);
    const counters =
      /"finance_counters_kind" CHECK \("kind" IN \(([^)]*)\)\)/.exec(last)![1];
    expect(counters.split(', ').sort()).toEqual(
      COUNTER_ORDER.map((k) => `'${k}'`).sort(),
    );
  });

  it('the CHECKs repeat the sources and the reason codes', () => {
    const tables = migration('20270615090000_gl_tables');
    expect(tables.replace(/\s+/g, ' ')).toContain(
      `"source" IN (${quoted(GL_SOURCES)})`.replace(/\s+/g, ' '),
    );
    expect(tables).toContain(
      `"reject_reason" IN (${quoted(REASON_CODES.glEntryReject)})`,
    );
    expect(tables).toContain(
      `"reopen_reason" IN (${quoted(REASON_CODES.glPeriodReopen)})`,
    );
  });
});
