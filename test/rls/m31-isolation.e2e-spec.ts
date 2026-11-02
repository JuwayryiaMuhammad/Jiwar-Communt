import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { dbClock, dbDate } from '../setup/compound-clock';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import { marketFileRow } from '../setup/market-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  accountId: string;
  vendorId: string;
  contractId: string;
  budgetId: string;
  lineId: string;
  otherLineId: string;
  commitmentId: string;
  disbursementId: string;
  /** A bank account payouts leave (ADR 0085). */
  cashAccountId: string;
}

interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  linked?: boolean;
}

let numbers = 5000;
const day = dbDate('2027-01-01');
const later = dbDate('2027-12-31');

async function invoiceRow(
  tx: TenantTxClient,
  own: Side,
  link: Side,
): Promise<string> {
  const id = newId();
  await tx.financeVendorInvoice.create({
    data: {
      id,
      tenantId: own.tenantId,
      number: ++numbers,
      vendorId: link.vendorId,
      vendorNumber: `INV-${numbers}`,
      issuedOn: day,
      dueOn: day,
      contractId: link.contractId,
      budgetLineId: link.lineId,
      invoiceFileId: await marketFileRow(tx, own.tenantId, 'expense_invoice'),
      subtotal: '100',
      tax: '0',
      total: '100',
      recordedById: link.accountId,
      recordedAt: dbClock(),
    },
  });
  await tx.financeVendorInvoiceLine.create({
    data: {
      tenantId: own.tenantId,
      invoiceId: id,
      position: 1,
      description: 'Isolated work',
      amount: '100',
    },
  });
  return id;
}

/**
 * The tables of ADR 0089: isolated like every other tenant table, linked
 * with composite keys. The RLS coverage test checks the policies exist;
 * this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'finance_budget_transfers',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.financeBudgetTransfer.create({
        data: {
          id,
          tenantId: own.tenantId,
          budgetId: link.budgetId,
          fromLineId: link.lineId,
          toLineId: link.otherLineId,
          amount: '1',
          reason: 'Isolated',
          status: 'applied',
          requestedById: link.accountId,
          requestedAt: dbClock(),
          decidedAt: dbClock(),
        },
      });
      return id;
    },
  },
  {
    table: 'finance_budget_line_months',
    key: 'line_id',
    insert: async (tx, own, link) => {
      await tx.financeBudgetLineMonth.createMany({
        data: Array.from({ length: 12 }, (_, k) => ({
          tenantId: own.tenantId,
          lineId: link.otherLineId,
          month: k + 1,
          amount: '10',
        })),
      });
      return link.otherLineId;
    },
  },
  {
    table: 'finance_budget_variance_notes',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.financeBudgetVarianceNote.create({
        data: {
          id,
          tenantId: own.tenantId,
          lineId: link.lineId,
          month: 1,
          reasonCode: 'timing',
          recordedById: link.accountId,
          recordedAt: dbClock(),
        },
      });
      return id;
    },
  },
  {
    table: 'finance_commitments',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.financeCommitment.create({
        data: {
          id,
          tenantId: own.tenantId,
          lineId: link.lineId,
          source: 'contract',
          contractId: link.contractId,
          contractPaymentId: newId(),
          vendorId: link.vendorId,
          amount: '10',
          createdAt: dbClock(),
        },
      });
      return id;
    },
  },
  {
    table: 'finance_commitment_releases',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.financeCommitmentRelease.create({
        data: {
          id,
          tenantId: own.tenantId,
          commitmentId: link.commitmentId,
          amount: '0.01',
          reason: 'changed',
          createdAt: dbClock(),
        },
      });
      return id;
    },
  },
  {
    table: 'finance_vendor_invoices',
    insert: invoiceRow,
  },
  {
    table: 'finance_vendor_invoice_lines',
    key: 'invoice_id',
    insert: invoiceRow,
  },
  {
    table: 'finance_contract_disbursements',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.financeContractDisbursement.create({
        data: {
          id,
          tenantId: own.tenantId,
          number: ++numbers,
          kind: 'advance',
          contractId: link.contractId,
          vendorId: link.vendorId,
          amount: '10',
          requestedById: link.accountId,
          requestedAt: dbClock(),
        },
      });
      return id;
    },
  },
  {
    table: 'finance_vendor_payouts',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.financeVendorPayout.create({
        data: {
          id,
          tenantId: own.tenantId,
          number: ++numbers,
          kind: 'advance',
          disbursementId: link.disbursementId,
          contractId: link.contractId,
          vendorId: link.vendorId,
          gross: '10',
          net: '10',
          method: 'bank_transfer',
          paidOn: day,
          paidById: link.accountId,
          cashAccountId: link.cashAccountId,
          createdAt: dbClock(),
        },
      });
      // What it paid left its account (checked at commit).
      await tx.financeCashMovement.create({
        data: {
          id: newId(),
          tenantId: own.tenantId,
          accountId: link.cashAccountId,
          kind: 'payout',
          amount: '-10',
          onDay: day,
          payoutId: id,
          recordedById: link.accountId,
        },
      });
      return id;
    },
  },
  {
    table: 'finance_vendor_guarantees',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.financeVendorGuarantee.create({
        data: {
          id,
          tenantId: own.tenantId,
          contractId: link.contractId,
          vendorId: link.vendorId,
          kind: 'performance',
          issuer: 'Isolated Bank',
          reference: `G-${++numbers}`,
          amount: '10',
          issuedOn: day,
          expiresOn: later,
          recordedById: link.accountId,
          recordedAt: dbClock(),
        },
      });
      return id;
    },
  },
];

describe('RLS isolation — payables and commitments (ADR 0089)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(s: Side, fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Payables ${label}`);
    const s: Side = {
      tenantId,
      accountId: (await createAccountRow(h, tenantId)).id,
      vendorId: newId(),
      contractId: newId(),
      budgetId: newId(),
      lineId: newId(),
      otherLineId: newId(),
      commitmentId: newId(),
      disbursementId: newId(),
      cashAccountId: newId(),
    };
    await inTenant(s, async (tx) => {
      await tx.vendor.create({
        data: {
          id: s.vendorId,
          tenantId,
          number: ++numbers,
          name: `Payables ${s.vendorId}`,
        },
      });
      await tx.maintenanceContract.create({
        data: {
          id: s.contractId,
          tenantId,
          code: `PAY-${++numbers}`,
          kind: 'amc',
          vendorId: s.vendorId,
          vendorName: 'Isolated',
          startsOn: day,
          endsOn: later,
        },
      });
      await tx.financeBudget.create({
        data: {
          id: s.budgetId,
          tenantId,
          fiscalYear: 2027,
          startsOn: day,
          endsOn: later,
          createdById: s.accountId,
          createdAt: dbClock(),
        },
      });
      await tx.financeBudgetLine.createMany({
        data: [
          {
            id: s.lineId,
            tenantId,
            budgetId: s.budgetId,
            category: 'maintenance',
            amount: '1000',
          },
          {
            id: s.otherLineId,
            tenantId,
            budgetId: s.budgetId,
            category: 'cleaning',
            amount: '120',
          },
        ],
      });
      await tx.financeCommitment.create({
        data: {
          id: s.commitmentId,
          tenantId,
          lineId: s.lineId,
          source: 'contract',
          contractId: s.contractId,
          contractPaymentId: newId(),
          amount: '10',
          createdAt: dbClock(),
        },
      });
      await tx.financeCashAccount.create({
        data: {
          id: s.cashAccountId,
          tenantId,
          kind: 'bank',
          name: 'Isolated bank',
          openedOn: day,
          createdById: s.accountId,
        },
      });
      await tx.financeContractDisbursement.create({
        data: {
          id: s.disbursementId,
          tenantId,
          number: ++numbers,
          kind: 'advance',
          contractId: s.contractId,
          vendorId: s.vendorId,
          amount: '10',
          requestedById: s.accountId,
          requestedAt: dbClock(),
        },
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
      .filter((m) => m >= '20270601090000' && m < '20270602')
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
      expect(await count(a)).toBeGreaterThanOrEqual(1);
      expect(await count(b)).toBe(0);
      expect(await count(b, true)).toBe(0);
    });

    it('B updates and deletes nothing of A', async () => {
      const run = (sql: string) =>
        inTenant(b, (tx) =>
          tx
            .$executeRawUnsafe(sql, ids[name])
            .catch((e: Error) =>
              /permission denied|immutable|keeps|never|moves forward|closes once/.test(
                e.message,
              )
                ? 0
                : Promise.reject(e),
            ),
        );
      expect(
        await run(
          `UPDATE "${name}" SET tenant_id = tenant_id WHERE "${key}" = $1::uuid`,
        ),
      ).toBe(0);
      expect(await run(`DELETE FROM "${name}" WHERE "${key}" = $1::uuid`)).toBe(
        0,
      );
    });

    it('acting as B, a row with A’s tenant_id is refused', async () => {
      await expect(inTenant(b, (tx) => t.insert(tx, a, a))).rejects.toThrow(
        /row-level security/,
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
