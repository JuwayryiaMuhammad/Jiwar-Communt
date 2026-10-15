import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  allocationRow,
  batchRow,
  creditNoteRow,
  disputeRow,
  eventRow,
  gatewayRow,
  instalmentPlanRow,
  invoiceRow,
  noticeRow,
  overrideRow,
  paymentRow,
  planRow,
  refundRow,
  sessionInvoiceRow,
  sessionRow,
} from '../setup/finance-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  accountId: string;
  batchId: string;
  invoiceId: string;
  planId: string;
  paymentId: string;
  sessionId: string;
}

/**
 * One finance table: how to insert a row in a compound. `link` points the
 * row's foreign keys at another compound's rows, which the composite keys
 * must refuse.
 */
interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  key?: string;
  linked?: boolean;
}

/**
 * The finance tables (ADR 0046, 0048): isolated like every other tenant table,
 * linked with composite keys. The RLS coverage test checks the policies
 * exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'finance_settings',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.financeSettings.upsert({
        where: { tenantId: own.tenantId },
        create: { tenantId: own.tenantId },
        update: {},
      });
      return own.tenantId;
    },
  },
  {
    // One per compound: linked, the compound's own row is pointed at the
    // other's account (a second row would trip the key first).
    table: 'finance_gateways',
    key: 'tenant_id',
    insert: async (tx, own, link) => {
      if (own === link) return gatewayRow(tx, own.tenantId, own.accountId);
      await tx.financeGateway.update({
        where: { tenantId: own.tenantId },
        data: { updatedById: link.accountId },
      });
      return own.tenantId;
    },
  },
  {
    table: 'invoice_batches',
    insert: (tx, own, link) =>
      batchRow(tx, {
        tenantId: own.tenantId,
        unitId: link.unitId,
        createdById: link.accountId,
      }),
  },
  {
    table: 'invoices',
    // One per unit and batch: a fresh batch of the compound's own.
    insert: async (tx, own, link) =>
      invoiceRow(tx, {
        tenantId: own.tenantId,
        unitId: own.unitId,
        batchId:
          own === link
            ? await batchRow(tx, {
                tenantId: own.tenantId,
                unitId: own.unitId,
                createdById: own.accountId,
              })
            : link.batchId,
        createdById: link.accountId,
      }),
  },
  {
    table: 'credit_notes',
    insert: (tx, own, link) =>
      creditNoteRow(tx, {
        tenantId: own.tenantId,
        invoiceId: link.invoiceId,
        createdById: link.accountId,
      }),
  },
  {
    // One per invoice: a fresh invoice of the compound's own.
    table: 'instalment_plans',
    insert: async (tx, own, link) =>
      instalmentPlanRow(tx, {
        tenantId: own.tenantId,
        unitId: link.unitId,
        invoiceId:
          own === link
            ? await invoiceRow(tx, {
                tenantId: own.tenantId,
                unitId: own.unitId,
                batchId: await batchRow(tx, {
                  tenantId: own.tenantId,
                  unitId: own.unitId,
                  createdById: own.accountId,
                }),
                createdById: own.accountId,
              })
            : link.invoiceId,
        createdById: link.accountId,
      }),
  },
  {
    // One open per invoice: a fresh invoice of the compound's own.
    table: 'invoice_disputes',
    insert: async (tx, own, link) =>
      disputeRow(tx, {
        tenantId: own.tenantId,
        unitId: link.unitId,
        invoiceId:
          own === link
            ? await invoiceRow(tx, {
                tenantId: own.tenantId,
                unitId: own.unitId,
                batchId: await batchRow(tx, {
                  tenantId: own.tenantId,
                  unitId: own.unitId,
                  createdById: own.accountId,
                }),
                createdById: own.accountId,
              })
            : link.invoiceId,
        openedById: link.accountId,
      }),
  },
  {
    table: 'invoice_notices',
    insert: (tx, own, link) =>
      noticeRow(tx, { tenantId: own.tenantId, invoiceId: link.invoiceId }),
  },
  {
    table: 'billing_plans',
    insert: (tx, own, link) =>
      planRow(tx, { tenantId: own.tenantId, createdById: link.accountId }),
  },
  {
    table: 'billing_plan_overrides',
    insert: async (tx, own, link) =>
      overrideRow(tx, {
        tenantId: own.tenantId,
        planId:
          own === link
            ? await planRow(tx, {
                tenantId: own.tenantId,
                createdById: own.accountId,
              })
            : link.planId,
        unitId: link.unitId,
        updatedById: link.accountId,
      }),
  },
  {
    table: 'finance_payments',
    insert: (tx, own, link) =>
      paymentRow(tx, {
        tenantId: own.tenantId,
        unitId: link.unitId,
        recordedById: link.accountId,
      }),
  },
  {
    // A refund and its one source: the source points at the other's payment.
    table: 'finance_refunds',
    insert: (tx, own, link) =>
      refundRow(tx, {
        tenantId: own.tenantId,
        unitId: link.unitId,
        paymentId: link.paymentId,
        recordedById: link.accountId,
      }),
  },
  {
    // A source of a refund of the compound's own, taking from its own
    // payment or the other's (the refund adds up to its one source).
    table: 'finance_refund_sources',
    insert: async (tx, own, link) => {
      const refund = newId();
      await tx.financeRefund.create({
        data: {
          id: refund,
          tenantId: own.tenantId,
          kind: 'refund',
          unitId: own.unitId,
          number: Math.floor(Math.random() * 1_000_000_000) + 1,
          amount: 1,
          currency: 'EGP',
          channel: 'cash',
          refundedOn: new Date(
            `${new Date().toISOString().slice(0, 10)}T00:00:00Z`,
          ),
          recordedById: own.accountId,
        },
      });
      return (
        await tx.financeRefundSource.create({
          data: {
            id: newId(),
            tenantId: own.tenantId,
            refundId: refund,
            paymentId: link.paymentId,
            amount: 1,
          },
        })
      ).id;
    },
  },
  {
    table: 'finance_allocations',
    insert: (tx, own, link) =>
      allocationRow(tx, {
        tenantId: own.tenantId,
        paymentId: link.paymentId,
        invoiceId: link.invoiceId,
      }),
  },
  {
    // One live per unit: a fresh unit of the compound's own.
    table: 'payment_sessions',
    insert: async (tx, own, link) =>
      sessionRow(tx, {
        tenantId: own.tenantId,
        unitId:
          own === link
            ? (
                await tx.unit.create({
                  data: {
                    id: newId(),
                    tenantId: own.tenantId,
                    code: `FIN-${Date.now()}-${Math.random()}`.slice(0, 30),
                  },
                })
              ).id
            : link.unitId,
        accountId: link.accountId,
      }),
  },
  {
    table: 'payment_session_invoices',
    insert: (tx, own, link) =>
      sessionInvoiceRow(tx, {
        tenantId: own.tenantId,
        sessionId: link.sessionId,
        invoiceId: link.invoiceId,
      }),
  },
  {
    table: 'payment_gateway_events',
    insert: (tx, own, link) =>
      eventRow(tx, { tenantId: own.tenantId, sessionId: link.sessionId }),
  },
];

describe('Finance — RLS isolation', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Finance ${label}`);
    const s: Side = {
      tenantId,
      unitId: (await createUnit(h, tenantId)).id,
      accountId: (await createAccountRow(h, tenantId)).id,
      batchId: '',
      invoiceId: '',
      planId: '',
      paymentId: '',
      sessionId: '',
    };
    await inTenant(s, async (tx) => {
      s.batchId = await batchRow(tx, {
        tenantId,
        unitId: s.unitId,
        createdById: s.accountId,
      });
      s.invoiceId = await invoiceRow(tx, {
        tenantId,
        unitId: s.unitId,
        batchId: s.batchId,
        createdById: s.accountId,
      });
      s.planId = await planRow(tx, { tenantId, createdById: s.accountId });
      s.paymentId = await paymentRow(tx, {
        tenantId,
        unitId: s.unitId,
        recordedById: s.accountId,
      });
      s.sessionId = await sessionRow(tx, {
        tenantId,
        unitId: s.unitId,
        accountId: s.accountId,
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
              /permission denied/.test(e.message) ? 0 : Promise.reject(e),
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
        /row-level security|violates/,
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
