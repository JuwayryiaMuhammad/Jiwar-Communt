import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import {
  actionRow,
  batchRow,
  bundleRow,
  deviceRow,
  envelopeRow,
  flagRow,
} from '../setup/offline-rows';
import { gateRow, shiftRow } from '../setup/security-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  accountId: string;
  deviceId: string;
  gateId: string;
  shiftId: string;
  bundleId: string;
  batchId: string;
  actionId: string;
}

/**
 * One table: how to insert a row in a compound. `link` points the row's
 * foreign keys at another compound's rows, which the composite keys must
 * refuse.
 */
interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  key?: string;
  /** The key's SQL type, `uuid` unless said. */
  keyType?: string;
  linked?: boolean;
}

/**
 * The tables of the gate offline (ADR 0057): isolated like every other
 * tenant table, linked with composite keys. The RLS coverage test checks
 * the policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'gate_devices',
    insert: (tx, own, link) =>
      deviceRow(tx, { tenantId: own.tenantId, enrolledById: link.accountId }),
  },
  {
    table: 'gate_offline_bundles',
    insert: (tx, own, link) =>
      bundleRow(tx, {
        tenantId: own.tenantId,
        deviceId: link.deviceId,
        shiftId: link.shiftId,
        gateId: link.gateId,
        guardId: link.accountId,
      }),
  },
  {
    table: 'gate_device_envelopes',
    key: 'signature_sha256',
    keyType: 'text',
    insert: (tx, own, link) =>
      envelopeRow(tx, { tenantId: own.tenantId, deviceId: link.deviceId }),
  },
  {
    table: 'gate_offline_batches',
    insert: (tx, own, link) =>
      batchRow(tx, {
        tenantId: own.tenantId,
        deviceId: link.deviceId,
        uploadedById: link.accountId,
      }),
  },
  {
    table: 'gate_offline_actions',
    insert: (tx, own, link) =>
      actionRow(tx, {
        tenantId: own.tenantId,
        deviceId: link.deviceId,
        batchId: link.batchId,
        bundleId: link.bundleId,
        guardId: link.accountId,
        shiftId: link.shiftId,
        gateId: link.gateId,
      }),
  },
  {
    table: 'gate_offline_flags',
    insert: (tx, own, link) =>
      flagRow(tx, {
        tenantId: own.tenantId,
        deviceId: link.deviceId,
        batchId: link.batchId,
        actionId: link.actionId,
      }),
  },
];

describe('RLS isolation — the gate offline (ADR 0057)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Gate offline ${label}`);
    const s: Side = {
      tenantId,
      accountId: (await createAccountRow(h, tenantId)).id,
      deviceId: '',
      gateId: '',
      shiftId: '',
      bundleId: '',
      batchId: '',
      actionId: '',
    };
    await inTenant(s, async (tx) => {
      s.gateId = await gateRow(tx, tenantId);
      s.shiftId = await shiftRow(tx, {
        tenantId,
        guardId: s.accountId,
        gateId: s.gateId,
      });
      s.deviceId = await deviceRow(tx, {
        tenantId,
        enrolledById: s.accountId,
      });
      const at = { tenantId, deviceId: s.deviceId };
      s.bundleId = await bundleRow(tx, {
        ...at,
        shiftId: s.shiftId,
        gateId: s.gateId,
        guardId: s.accountId,
      });
      s.batchId = await batchRow(tx, { ...at, uploadedById: s.accountId });
      s.actionId = await actionRow(tx, {
        ...at,
        batchId: s.batchId,
        bundleId: s.bundleId,
        guardId: s.accountId,
        shiftId: s.shiftId,
        gateId: s.gateId,
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
    const cast = t.keyType ?? 'uuid';

    it('A sees its row; B does not, by its key or in a full scan', async () => {
      const count = (s: Side, all = false) =>
        inTenant(s, async (tx) => {
          const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "${name}" WHERE ${all ? `tenant_id = $1::uuid` : `"${key}" = $1::${cast}`}`,
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
          `UPDATE "${name}" SET tenant_id = tenant_id WHERE "${key}" = $1::${cast}`,
        ),
      ).toBe(0);
      expect(
        await run(`DELETE FROM "${name}" WHERE "${key}" = $1::${cast}`),
      ).toBe(0);
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
