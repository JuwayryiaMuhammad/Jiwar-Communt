import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import { BUDGET_CATEGORIES } from '../../src/finance/budgets/budget-rules';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { dbDate } from '../setup/compound-clock';
import {
  activateBudget,
  batchRow,
  budgetRow,
  invoiceRow,
  planRow,
} from '../setup/finance-rows';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  staffId: string;
  planId: string;
  budgetId: string;
  reportId: string;
  invoiceId: string;
}

/**
 * One table of R11c-1a: how to insert a row in a compound. `link` points
 * the row's foreign keys at another compound's rows, which the composite
 * keys must refuse; `key` is the column it is found by.
 */
interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  linked?: boolean;
}

/** Each report its own day, and each item its own position. */
let reportDays = 0;
let lineCategories = 0;
let duesMonths = 0;
/**
 * A budget's latest report: each new one supersedes it, so "one first
 * report a budget" is never in the way.
 */
const latestReport = new Map<string, string>();

async function spendingReport(tx: TenantTxClient, own: Side, link: Side) {
  const id = newId();
  const d = String(1 + (reportDays++ % 28)).padStart(2, '0');
  await tx.financeSpendingReport.create({
    data: {
      id,
      tenantId: own.tenantId,
      budgetId: link.budgetId,
      fiscalYear: 2031,
      startsOn: dbDate('2031-01-01'),
      asOf: dbDate(`2031-0${1 + Math.floor(reportDays / 28)}-${d}`),
      supersedesId: latestReport.get(link.budgetId) ?? null,
      publishedBy: link.staffId,
    },
  });
  latestReport.set(link.budgetId, id);
  return id;
}

/**
 * The tables of money and the unit (ADR 0069): isolated like every other
 * tenant table, linked with composite keys. The RLS coverage test checks
 * the policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'billing_plan_amount_changes',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.billingPlanAmountChange.create({
        data: {
          id,
          tenantId: own.tenantId,
          planId: link.planId,
          fromAmount: '100',
          toAmount: '120',
          effectiveOn: dbDate('2031-01-01'),
          changedById: link.staffId,
        },
      });
      return id;
    },
  },
  { table: 'finance_spending_reports', insert: spendingReport },
  {
    table: 'collector_visits',
    insert: async (tx, own, link) => {
      const id = newId();
      // Closed: one open a unit is never in the way.
      await tx.collectorVisit.create({
        data: {
          id,
          tenantId: own.tenantId,
          unitId: link.unitId,
          requestedById: link.staffId,
          windowStartsAt: new Date('2031-01-05T08:00:00Z'),
          windowEndsAt: new Date('2031-01-05T10:00:00Z'),
          status: 'cancelled',
          cancelSide: 'resident',
          closedAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'finance_dues_notices',
    key: 'unit_id',
    insert: async (tx, own, link) => {
      // A month of its own each time (one a unit and month).
      const month = `20${String(31 + duesMonths++).padStart(2, '0')}-01`;
      await tx.financeDuesNotice.create({
        data: { tenantId: own.tenantId, unitId: link.unitId, month },
      });
      return link.unitId;
    },
  },
  {
    table: 'instalment_plan_requests',
    insert: async (tx, own, link) => {
      const id = newId();
      // Decided rows: one pending a invoice is never in the way.
      await tx.instalmentPlanRequest.create({
        data: {
          id,
          tenantId: own.tenantId,
          invoiceId: link.invoiceId,
          unitId: link.unitId,
          requestedById: link.staffId,
          months: 3,
          status: 'withdrawn',
          decidedAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'finance_spending_report_lines',
    key: 'report_id',
    insert: async (tx, own, link) => {
      // On the linked side's report, a category each time: no report is
      // made here, so B's attempt meets this table's policy, not the
      // reports'.
      const reportId = link.reportId;
      await tx.financeSpendingReportLine.create({
        data: {
          tenantId: own.tenantId,
          reportId,
          category:
            BUDGET_CATEGORIES[lineCategories++ % BUDGET_CATEGORIES.length],
          allowance: '100',
          spent: '10',
        },
      });
      return reportId;
    },
  },
  {
    table: 'finance_spending_report_items',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.financeSpendingReportItem.create({
        data: {
          id,
          tenantId: own.tenantId,
          reportId: link.reportId,
          position: 1 + (reportDays++ % 20),
          textEn: 'Gardens',
          textAr: 'الحدائق',
        },
      });
      return id;
    },
  },
];

describe('RLS isolation — money and the unit (ADR 0069)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `R11c-1a ${label}`);
    const unit = await createUnit(h, tenantId);
    const staff = await createAccountRow(h, tenantId, 'staff');
    const s = { tenantId, unitId: unit.id, staffId: staff.id } as Side;
    await inTenant(s, async (tx) => {
      s.planId = await planRow(tx, { tenantId, createdById: staff.id });
      s.budgetId = await budgetRow(tx, {
        tenantId,
        createdById: staff.id,
      });
      await activateBudget(tx, {
        tenantId,
        budgetId: s.budgetId,
        raisedById: staff.id,
      });
      s.reportId = await spendingReport(tx, s, s);
      s.invoiceId = await invoiceRow(tx, {
        tenantId,
        unitId: unit.id,
        batchId: await batchRow(tx, {
          tenantId,
          unitId: unit.id,
          createdById: staff.id,
        }),
        createdById: staff.id,
      });
    });
    return s;
  };

  beforeAll(async () => {
    h = await createDbHarness();
    a = await side('A');
    b = await side('B');
    for (const t of TABLES)
      ids[t.table] = await inTenant(a, (tx) => t.insert(tx, a, a));
  });

  afterAll(() => h.close());

  it('covers every table the phase’s migrations create', () => {
    const dir = join(__dirname, '../../prisma/migrations');
    const created = readdirSync(dir)
      .filter((m) => m >= '20270105090000' && m < '20270106')
      .flatMap((m) =>
        [
          ...readFileSync(join(dir, m, 'migration.sql'), 'utf8').matchAll(
            /CREATE TABLE "([a-z_]+)"/g,
          ),
        ].map((x) => x[1]),
      );
    expect(TABLES.map((t) => t.table).sort()).toEqual(created.sort());
  });

  describe.each(TABLES.map((t) => [t.table, t] as const))('%s', (name, t) => {
    const key = t.key ?? 'id';

    it('A sees its row; B does not, by its key or in a full scan', async () => {
      const count = (s: Side, all = false) =>
        inTenant(s, async (tx) => {
          const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "${name}" WHERE ${all ? `tenant_id = $1::uuid` : `"${key}" = $1::uuid`}`,
            all ? a.tenantId : ids[name],
          );
          return Number(rows[0].n);
        });
      expect(await count(a)).toBe(1);
      expect(await count(b)).toBe(0);
      expect(await count(b, true)).toBe(0);
    });

    it('B updates and deletes nothing of A', async () => {
      const exec = (sql: string) =>
        inTenant(b, (tx) =>
          tx
            .$executeRawUnsafe(sql, ids[name])
            .catch((e: Error) =>
              /permission denied/.test(e.message) ? 0 : Promise.reject(e),
            ),
        );
      expect(
        await exec(
          `UPDATE "${name}" SET tenant_id = tenant_id WHERE "${key}" = $1::uuid`,
        ),
      ).toBe(0);
      expect(
        await exec(`DELETE FROM "${name}" WHERE "${key}" = $1::uuid`),
      ).toBe(0);
    });

    it('acting as B, a row with A’s tenant_id is refused', async () => {
      await expect(inTenant(b, (tx) => t.insert(tx, a, a))).rejects.toThrow(
        new RegExp(`row-level security policy for table "${name}"`),
      );
    });

    if (t.linked !== false) {
      it('a row may not point at another compound’s rows (composite keys)', async () => {
        await expect(inTenant(a, (tx) => t.insert(tx, a, b))).rejects.toThrow(
          /foreign key|violates/i,
        );
      });
    }
  });
});
