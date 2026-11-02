import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { paymentRow } from '../setup/finance-rows';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  cashAccountRow,
  chequeRow,
  handinRow,
  investigationRow,
  matchRow,
  openingRow,
  statementImportRow,
  statementLineRow,
} from '../setup/treasury-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  staffId: string;
  receiverId: string;
  unitId: string;
  bankId: string;
  cashId: string;
  importId: string;
  lineId: string;
  handinId: string;
}

/** One table of the treasury: how to insert a row in a compound. */
interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
}

/**
 * The treasury's tables (ADR 0085): isolated like every other tenant
 * table, linked with composite keys. The RLS coverage test checks the
 * policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'finance_cash_accounts',
    insert: (tx, own, link) =>
      cashAccountRow(tx, { tenantId: own.tenantId, createdById: link.staffId }),
  },
  {
    table: 'finance_cash_movements',
    insert: (tx, own, link) =>
      openingRow(tx, {
        tenantId: own.tenantId,
        accountId: link.bankId,
        recordedById: link.staffId,
      }),
  },
  {
    table: 'finance_custody_handins',
    insert: async (tx, own, link) => {
      const paymentId = await paymentRow(tx, {
        tenantId: own.tenantId,
        unitId: own.unitId,
        recordedById: own.staffId,
      });
      return handinRow(tx, {
        tenantId: own.tenantId,
        custodianId: own.staffId,
        receivedById: own.receiverId,
        cashAccountId: link.cashId,
        paymentId,
      });
    },
  },
  {
    table: 'finance_custody_handin_items',
    key: 'payment_id',
    insert: async (tx, own, link) => {
      const paymentId = await paymentRow(tx, {
        tenantId: own.tenantId,
        unitId: link.unitId,
        recordedById: link.staffId,
      });
      await handinRow(tx, {
        tenantId: own.tenantId,
        custodianId: own.staffId,
        receivedById: own.receiverId,
        cashAccountId: own.cashId,
        paymentId,
      });
      return paymentId;
    },
  },
  {
    table: 'finance_custody_investigations',
    insert: async (tx, own, link) => {
      const paymentId = await paymentRow(tx, {
        tenantId: own.tenantId,
        unitId: own.unitId,
        recordedById: own.staffId,
      });
      const handinId = await handinRow(tx, {
        tenantId: own.tenantId,
        custodianId: own.staffId,
        receivedById: own.receiverId,
        cashAccountId: own.cashId,
        paymentId,
      });
      return investigationRow(tx, {
        tenantId: own.tenantId,
        handinId,
        ownerId: link.receiverId,
      });
    },
  },
  {
    table: 'finance_cheques',
    insert: (tx, own, link) =>
      chequeRow(tx, {
        tenantId: own.tenantId,
        unitId: link.unitId,
        recordedById: own.staffId,
      }),
  },
  {
    table: 'finance_statement_imports',
    insert: (tx, own, link) =>
      statementImportRow(tx, {
        tenantId: own.tenantId,
        accountId: link.bankId,
        createdById: own.staffId,
      }),
  },
  {
    table: 'finance_statement_lines',
    insert: (tx, own, link) =>
      statementLineRow(tx, {
        tenantId: own.tenantId,
        accountId: own.bankId,
        importId: link.importId,
      }),
  },
  {
    table: 'finance_statement_matches',
    insert: async (tx, own, link) => {
      const lineId = await statementLineRow(tx, {
        tenantId: own.tenantId,
        accountId: own.bankId,
        importId: own.importId,
      });
      return matchRow(tx, {
        tenantId: own.tenantId,
        lineId,
        accountId: own.bankId,
        matchedById: link.staffId,
      });
    },
  },
];

describe('RLS isolation — treasury and custody (ADR 0085)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Treasury ${label}`);
    const staff = await createAccountRow(h, tenantId, 'staff');
    const receiver = await createAccountRow(h, tenantId, 'staff');
    const unit = await createUnit(h, tenantId);
    return inTenant({ tenantId }, async (tx) => {
      const bankId = await cashAccountRow(tx, {
        tenantId,
        createdById: staff.id,
      });
      const cashId = await cashAccountRow(tx, {
        tenantId,
        createdById: staff.id,
        kind: 'cash',
      });
      const importId = await statementImportRow(tx, {
        tenantId,
        accountId: bankId,
        createdById: staff.id,
      });
      const lineId = await statementLineRow(tx, {
        tenantId,
        accountId: bankId,
        importId,
      });
      const paymentId = await paymentRow(tx, {
        tenantId,
        unitId: unit.id,
        recordedById: staff.id,
      });
      const handinId = await handinRow(tx, {
        tenantId,
        custodianId: staff.id,
        receivedById: receiver.id,
        cashAccountId: cashId,
        paymentId,
      });
      return {
        tenantId,
        staffId: staff.id,
        receiverId: receiver.id,
        unitId: unit.id,
        bankId,
        cashId,
        importId,
        lineId,
        handinId,
      };
    });
  };

  beforeAll(async () => {
    h = await createDbHarness();
    a = await side('A');
    b = await side('B');
    for (const t of TABLES)
      ids[t.table] = await inTenant(a, (tx) => t.insert(tx, a, a));
  }, 60_000);

  afterAll(() => h.close());

  it('covers every table the phase’s migrations create', () => {
    const dir = join(__dirname, '../../prisma/migrations');
    const created = readdirSync(dir)
      .filter((m) => m >= '20270427090000' && m < '20270428')
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
      const run = (sql: string) =>
        inTenant(b, (tx) =>
          tx
            .$executeRawUnsafe(sql, ids[name])
            .catch((e: Error) =>
              /permission denied|immutable|insufficient/i.test(e.message)
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
        /row-level security|violates/,
      );
    });

    it('a row may not point at another compound’s rows (composite keys)', async () => {
      await expect(inTenant(a, (tx) => t.insert(tx, a, b))).rejects.toThrow(
        /foreign key|violates/i,
      );
    });
  });
});
