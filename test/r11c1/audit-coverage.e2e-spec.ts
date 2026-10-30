import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { auditReaders } from '../setup/audit';
import { R11C1A_COVERAGE } from '../setup/audit-coverage-split';
import type { Compound } from '../setup/community';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import {
  activateBudget,
  budgetLineRow,
  budgetRow,
} from '../setup/finance-rows';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const MARKER = 'AUDIT-r11c1-secret';

/**
 * One scenario per entry of money and the unit's catalog (ADR 0014,
 * 0069): actor, target and metadata — codes, ids, days and counts, never
 * the staff's words or anything that names a person.
 */
const covered = new Set<string>();

describe('Audit coverage — money and the unit', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: FinanceSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    read = auditReaders(h);
    s = await f.setUp('R11c-1a Audit Court');
  }, 90_000);

  afterAll(() => h.close());

  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) => f.inTx(s.c, fn);

  async function single(c: Compound, action: string, targetId: string) {
    const rows = await read.tenant(c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  describe('where the fees went', () => {
    it('spending_report.published — the budget, its year, the day and how many items; never their words', async () => {
      const budgetId = await inTx(async (tx) => {
        const id = await budgetRow(tx, {
          tenantId: s.c.tenantId,
          createdById: s.c.managerId,
        });
        await budgetLineRow(tx, { tenantId: s.c.tenantId, budgetId: id });
        await activateBudget(tx, {
          tenantId: s.c.tenantId,
          budgetId: id,
          raisedById: s.c.managerId,
        });
        return id;
      });
      const report = (
        await f
          .http('post', '/staff/finance/spending-reports', s.accountant.token, {
            budgetId,
            summaryEn: MARKER,
            summaryAr: MARKER,
            items: [{ textEn: MARKER, textAr: MARKER }],
          })
          .expect(201)
      ).body as { id: string; fiscalYear: number; asOf: string };
      const row = await single(s.c, 'spending_report.published', report.id);
      expect(row).toMatchObject({
        actorId: s.accountant.id,
        metadata: {
          budgetId,
          fiscalYear: report.fiscalYear,
          asOf: report.asOf,
          items: 1,
        },
      });
      expect(JSON.stringify(row)).not.toContain(MARKER);
    });
  });

  describe('catalog completeness', () => {
    it('every entry of money and the unit has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of R11C1A_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...R11C1A_COVERAGE].sort());
    });
  });
});
