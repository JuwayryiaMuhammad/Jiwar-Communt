import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  requestRow as managementRequestRow,
  topicRow,
} from '../setup/management-rows';
import {
  favouriteRow,
  partnerHoursRow,
  partnerRow,
  partnerServiceRow,
  complaintRow,
  priceItemRow,
  ratingRow,
  requestEventRow,
  requestItemRow,
  requestRow,
  subcategoryRow,
} from '../setup/partners-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  accountId: string;
  partnerId: string;
  subcategoryId: string;
  requestId: string;
  managementRequestId: string;
}

/**
 * One partners table: how to insert a row in a compound. `link` points the
 * row's foreign keys at another compound's rows, which the composite keys
 * must refuse.
 */
interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  /** The column the row is found by (`id` unless the table has none). */
  key?: string;
  /** False when the row has no foreign key into another tenant table. */
  linked?: boolean;
  /**
   * A provisioned row is read back, not inserted: this writes a new one
   * for `own`, which acting as another compound must be refused.
   */
  forge?(tx: TenantTxClient, own: Side): Promise<unknown>;
}

/**
 * The partners tables (ADR 0060): isolated like every other tenant table,
 * linked with composite keys. The RLS coverage test checks the policies
 * exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'partner_settings',
    key: 'tenant_id',
    linked: false,
    // Every compound has its row from the provisioning: read it back.
    insert: (tx, own) => Promise.resolve(own.tenantId),
    forge: (tx, own) =>
      tx.partnerSettings.create({ data: { tenantId: own.tenantId } }),
  },
  {
    table: 'partner_subcategories',
    linked: false,
    insert: (tx, own) => subcategoryRow(tx, own.tenantId),
  },
  {
    table: 'partners',
    insert: (tx, own, link) =>
      partnerRow(tx, { tenantId: own.tenantId, createdById: link.accountId }),
  },
  {
    table: 'partner_services',
    insert: (tx, own, link) =>
      partnerServiceRow(tx, {
        tenantId: own.tenantId,
        partnerId: link.partnerId,
        subcategoryId: link.subcategoryId,
      }),
  },
  {
    table: 'partner_hours',
    insert: (tx, own, link) =>
      partnerHoursRow(tx, {
        tenantId: own.tenantId,
        partnerId: link.partnerId,
      }),
  },
  {
    table: 'partner_price_items',
    insert: (tx, own, link) =>
      priceItemRow(tx, { tenantId: own.tenantId, partnerId: link.partnerId }),
  },
  {
    table: 'partner_favourites',
    key: 'partner_id',
    insert: async (tx, own, link) =>
      favouriteRow(tx, {
        tenantId: own.tenantId,
        accountId: link.accountId,
        partnerId:
          own === link
            ? await partnerRow(tx, {
                tenantId: own.tenantId,
                createdById: own.accountId,
              })
            : link.partnerId,
      }),
  },
  {
    table: 'partner_request_counters',
    key: 'tenant_id',
    linked: false,
    // Provisioned with the compound too.
    insert: (tx, own) => Promise.resolve(own.tenantId),
    forge: (tx, own) =>
      tx.partnerRequestCounter.create({ data: { tenantId: own.tenantId } }),
  },
  {
    table: 'partner_requests',
    insert: (tx, own, link) =>
      requestRow(tx, {
        tenantId: own.tenantId,
        partnerId: link.partnerId,
        unitId: link.unitId,
        requesterId: link.accountId,
      }),
  },
  {
    table: 'partner_request_items',
    insert: (tx, own, link) =>
      requestItemRow(tx, { tenantId: own.tenantId, requestId: link.requestId }),
  },
  {
    table: 'partner_request_events',
    insert: (tx, own, link) =>
      requestEventRow(tx, {
        tenantId: own.tenantId,
        requestId: link.requestId,
        actorAccountId: link.accountId,
      }),
  },
  {
    table: 'partner_ratings',
    key: 'request_id',
    insert: async (tx, own, link) =>
      ratingRow(tx, {
        tenantId: own.tenantId,
        requestId:
          own === link
            ? await requestRow(tx, {
                tenantId: own.tenantId,
                partnerId: own.partnerId,
                unitId: own.unitId,
                requesterId: own.accountId,
              })
            : link.requestId,
        partnerId: link.partnerId,
        raterAccountId: link.accountId,
      }),
  },
  {
    table: 'partner_complaints',
    insert: async (tx, own, link) =>
      complaintRow(tx, {
        tenantId: own.tenantId,
        requestId:
          own === link
            ? await requestRow(tx, {
                tenantId: own.tenantId,
                partnerId: own.partnerId,
                unitId: own.unitId,
                requesterId: own.accountId,
              })
            : link.requestId,
        partnerId: link.partnerId,
        complainantId: link.accountId,
        managementRequestId:
          own === link
            ? await managementRequestRow(tx, {
                tenantId: own.tenantId,
                topicId: await topicRow(tx, own.tenantId),
                authorId: own.accountId,
              })
            : link.managementRequestId,
      }),
  },
];

describe('RLS isolation — partners (ADR 0060)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(s: Side, fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Partners ${label}`);
    const s: Side = {
      tenantId,
      unitId: (await createUnit(h, tenantId)).id,
      accountId: (await createAccountRow(h, tenantId)).id,
      partnerId: '',
      subcategoryId: '',
      requestId: '',
      managementRequestId: '',
    };
    await inTenant(s, async (tx) => {
      s.partnerId = await partnerRow(tx, {
        tenantId,
        createdById: s.accountId,
      });
      s.subcategoryId = await subcategoryRow(tx, tenantId);
      s.requestId = await requestRow(tx, {
        tenantId,
        partnerId: s.partnerId,
        unitId: s.unitId,
        requesterId: s.accountId,
      });
      s.managementRequestId = await managementRequestRow(tx, {
        tenantId,
        topicId: await topicRow(tx, tenantId),
        authorId: s.accountId,
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
      await expect(
        inTenant(b, (tx) => (t.forge ? t.forge(tx, a) : t.insert(tx, a, a))),
      ).rejects.toThrow(/row-level security/);
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
