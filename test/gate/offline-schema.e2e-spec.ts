import { Client } from 'pg';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import { deviceRow, offlineAt, publicKeyOf } from '../setup/offline-rows';

/**
 * The gate offline's tables (ADR 0057) at the database: what the app may
 * write; a device keeps its key and is revoked once; the shapes the CHECKs
 * hold whatever the services do. Every instant is written out.
 */
describe('The gate offline’s tables — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let tenantId: string;
  let guardId: string;
  let managerId: string;
  let deviceId: string;

  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(tenantId, () => h.tenantTx.withTenantTx(fn));

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Offline schema');
    guardId = (await createAccountRow(h, tenantId)).id;
    managerId = (await createAccountRow(h, tenantId)).id;
    await inTx(async (tx) => {
      deviceId = await deviceRow(tx, { tenantId, enrolledById: guardId });
    });
    app = new Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
  }, 120_000);

  afterAll(async () => {
    await app.end();
    await h.close();
  });

  async function asApp(...statements: string[]) {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      let last;
      for (const sql of statements) last = await app.query(sql);
      return last;
    } finally {
      await app.query('ROLLBACK');
    }
  }
  const privileges = async (table: string) => {
    const { rows } = await app.query<Record<string, boolean>>(
      `SELECT has_table_privilege($1, 'SELECT') AS select,
              has_table_privilege($1, 'INSERT') AS insert,
              has_table_privilege($1, 'UPDATE') AS update,
              has_table_privilege($1, 'DELETE') AS delete,
              has_table_privilege($1, 'TRUNCATE') AS truncate`,
      [table],
    );
    return rows[0];
  };
  const at = (minutes: number) => `'${offlineAt(minutes).toISOString()}'`;

  describe('a device', () => {
    const where = () => `id = '${deviceId}'`;
    const revoke = (reason = 'lost') =>
      `UPDATE gate_devices SET revoked_at = ${at(60)},
         revoked_by_account_id = '${managerId}', revoke_reason = '${reason}'
       WHERE ${where()}`;

    it('the app reads, enrols and revokes; it never deletes or truncates', async () => {
      expect(await privileges('gate_devices')).toEqual({
        select: true,
        insert: true,
        update: true,
        delete: false,
        truncate: false,
      });
      await expect(
        asApp(`DELETE FROM gate_devices WHERE ${where()}`),
      ).rejects.toThrow(/permission denied/);
    });

    it('keeps its key and its enrolment', async () => {
      for (const set of [
        `public_key = '${publicKeyOf()}'`,
        `label = 'Gate 1 phone'`,
        `enrolled_by_account_id = '${managerId}'`,
        `enrolled_at = ${at(1)}`,
      ])
        await expect(
          asApp(`UPDATE gate_devices SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/keeps its key and is revoked once/);
    });

    it('is revoked once, never again nor back', async () => {
      await expect(asApp(revoke())).resolves.toMatchObject({ rowCount: 1 });
      for (const set of [
        `revoke_reason = 'stolen'`,
        `revoked_at = ${at(61)}`,
        `revoked_by_account_id = '${guardId}'`,
        `revoked_at = NULL, revoked_by_account_id = NULL, revoke_reason = NULL`,
      ])
        await expect(
          asApp(revoke(), `UPDATE gate_devices SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/keeps its key and is revoked once/);
    });

    it('the shapes of a key, a label and a revocation', async () => {
      const insert = (cols: string, values: string) =>
        asApp(
          `INSERT INTO gate_devices (id, tenant_id, enrolled_by_account_id, enrolled_at, ${cols})
           VALUES (gen_random_uuid(), '${tenantId}', '${guardId}', ${at(0)}, ${values})`,
        );
      await expect(insert('public_key', `'short'`)).rejects.toThrow(
        /gate_devices_public_key_shape/,
      );
      await expect(insert('public_key', `'${publicKeyOf()}='`)).rejects.toThrow(
        /gate_devices_public_key_shape/,
      );
      await expect(
        insert('public_key, label', `'${publicKeyOf()}', ''`),
      ).rejects.toThrow(/gate_devices_label/);
      await expect(
        insert('public_key, label', `'${publicKeyOf()}', '${'x'.repeat(41)}'`),
      ).rejects.toThrow(/gate_devices_label/);
      // All three of a revocation, or none; never before the enrolment.
      await expect(
        insert('public_key, revoked_at', `'${publicKeyOf()}', ${at(5)}`),
      ).rejects.toThrow(/gate_devices_revoke_shape/);
      await expect(
        insert(
          'public_key, revoked_at, revoked_by_account_id, revoke_reason',
          `'${publicKeyOf()}', ${at(-1)}, '${managerId}', 'lost'`,
        ),
      ).rejects.toThrow(/gate_devices_revoke_shape/);
      await expect(asApp(revoke('misplaced'))).rejects.toThrow(
        /gate_devices_revoke_reason/,
      );
    });

    it('one device per key in a compound', async () => {
      const key = publicKeyOf();
      const insert = () =>
        `INSERT INTO gate_devices (id, tenant_id, public_key, enrolled_by_account_id, enrolled_at)
         VALUES (gen_random_uuid(), '${tenantId}', '${key}', '${guardId}', ${at(0)})`;
      await expect(asApp(insert(), insert())).rejects.toThrow(
        /gate_devices_public_key_key/,
      );
    });
  });
});
