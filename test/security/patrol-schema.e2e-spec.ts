import { Client } from 'pg';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import { checkpointRow, rowHash } from '../setup/patrol-rows';
import { placeRow } from '../setup/safety-rows';
import { gateRow } from '../setup/security-rows';
import { required } from '../setup/test-env';

/**
 * The patrol tables (ADR 0052) at the database: what the app may write,
 * what the triggers keep, and the shapes the CHECKs hold whatever the
 * services do.
 */
describe('Patrol tables — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let migrator: Client;
  let tenantId: string;
  let managerId: string;
  let otherId: string;
  let gateId: string;
  let placeId: string;
  let checkpointId: string;

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Patrol schema');
    managerId = (await createAccountRow(h, tenantId)).id;
    otherId = (await createAccountRow(h, tenantId)).id;
    await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx: TenantTxClient) => {
        gateId = await gateRow(tx, tenantId);
        placeId = await placeRow(tx, tenantId);
        checkpointId = await checkpointRow(tx, {
          tenantId,
          gateId,
          createdById: managerId,
        });
      }),
    );
    app = new Client({ connectionString: process.env.DATABASE_URL });
    migrator = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await app.connect();
    await migrator.connect();
  }, 120_000);

  afterAll(async () => {
    await app.end();
    await migrator.end();
    await h.close();
  });

  async function attempt(client: Client, ...statements: string[]) {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      let last;
      for (const sql of statements) last = await client.query(sql);
      return last;
    } finally {
      await client.query('ROLLBACK');
    }
  }
  const asApp = (...statements: string[]) => attempt(app, ...statements);
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

  it('the app updates but never deletes or truncates what is kept', async () => {
    for (const table of ['patrol_checkpoints'])
      expect({ table, ...(await privileges(table)) }).toEqual({
        table,
        select: true,
        insert: true,
        update: true,
        delete: false,
        truncate: false,
      });
  });

  it('nothing kept is deleted or truncated, even by the owner', async () => {
    for (const table of ['patrol_checkpoints']) {
      // A row to refuse: a row trigger never fires on a DELETE of none.
      const found = await attempt(
        migrator,
        `SELECT 1 FROM "${table}" WHERE tenant_id = '${tenantId}' LIMIT 1`,
      );
      expect([table, found?.rowCount]).toEqual([table, 1]);
      await expect(
        attempt(
          migrator,
          `DELETE FROM "${table}" WHERE tenant_id = '${tenantId}'`,
        ),
      ).rejects.toThrow(/never deleted|append-only/);
      await expect(
        attempt(migrator, `TRUNCATE "${table}" CASCADE`),
      ).rejects.toThrow(/append-only|immutable|never/);
    }
  });

  describe('patrol_checkpoints', () => {
    const where = () => `id = '${checkpointId}'`;
    const retire = () =>
      `UPDATE patrol_checkpoints SET retired_at = now(), retired_by_account_id = '${managerId}' WHERE ${where()}`;

    it('its post never changes', async () => {
      for (const set of [
        `gate_id = NULL, place_id = '${placeId}'`,
        `gate_id = '${gateId}', place_id = '${placeId}'`,
        `created_by_account_id = '${otherId}'`,
      ])
        await expect(
          asApp(`UPDATE patrol_checkpoints SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/its post never changes/);
    });

    it('renamed and placed while in service; retired once, and then nothing changes', async () => {
      await asApp(
        `UPDATE patrol_checkpoints SET name_en = 'Moved', lat = 30.1, lng = 31.2, radius_m = 40 WHERE ${where()}`,
        retire(),
      );
      for (const set of [
        'retired_at = NULL, retired_by_account_id = NULL',
        "name_en = 'After'",
        'lat = 30, lng = 31, radius_m = 30',
        `token_hash = '${rowHash('after')}', token_issued_at = now() + interval '1 minute'`,
        "retired_at = retired_at + interval '1 minute'",
      ])
        await expect(
          asApp(
            retire(),
            `UPDATE patrol_checkpoints SET ${set} WHERE ${where()}`,
          ),
        ).rejects.toThrow(/retired once/);
    });

    it('a new token comes with a later issue time', async () => {
      await asApp(
        `UPDATE patrol_checkpoints SET token_hash = '${rowHash('new')}', token_issued_at = token_issued_at + interval '1 millisecond' WHERE ${where()}`,
      );
      await expect(
        asApp(
          `UPDATE patrol_checkpoints SET token_hash = '${rowHash('new')}' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/its post never changes/);
    });

    it('the shapes hold: one post, a whole position in range, a hash, who retired it', async () => {
      await expect(
        asApp(
          `INSERT INTO patrol_checkpoints (id, tenant_id, gate_id, place_id, name_en, name_ar, token_hash, token_issued_at, created_by_account_id, updated_at)
           VALUES (gen_random_uuid(), '${tenantId}', '${gateId}', '${placeId}', 'Both', 'كلاهما', '${rowHash('both')}', now(), '${managerId}', now())`,
        ),
      ).rejects.toThrow(/patrol_checkpoints_one_post/);
      for (const [set, check] of [
        ['lat = 30', 'patrol_checkpoints_position_shape'],
        ['lat = 30, lng = 31', 'patrol_checkpoints_position_shape'],
        [
          'lat = 91, lng = 31, radius_m = 30',
          'patrol_checkpoints_position_range',
        ],
        [
          'lat = 30, lng = 31, radius_m = 4',
          'patrol_checkpoints_position_range',
        ],
        [
          "token_hash = 'ABC', token_issued_at = token_issued_at + interval '1 minute'",
          'patrol_checkpoints_token_hash_shape',
        ],
        ['retired_at = now()', 'patrol_checkpoints_retired_shape'],
        ["name_ar = ''", 'patrol_checkpoints_names_length'],
      ] as const)
        await expect(
          asApp(`UPDATE patrol_checkpoints SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(new RegExp(check));
    });

    it('two in service never share a name; a retired one frees it', async () => {
      const twin = (name: string) =>
        `INSERT INTO patrol_checkpoints (id, tenant_id, gate_id, name_en, name_ar, token_hash, token_issued_at, created_by_account_id, updated_at)
         SELECT gen_random_uuid(), tenant_id, gate_id, upper(${name}), name_ar || ' 2', '${rowHash('twin')}', now(), created_by_account_id, now()
           FROM patrol_checkpoints WHERE ${where()}`;
      await expect(asApp(twin('name_en'))).rejects.toThrow(
        /patrol_checkpoints_active_name_en_key/,
      );
      await asApp(retire(), twin('name_en'));
    });
  });
});
