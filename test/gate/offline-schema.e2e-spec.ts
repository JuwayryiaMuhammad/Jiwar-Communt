import { Client } from 'pg';
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
  offlineAt,
  publicKeyOf,
} from '../setup/offline-rows';
import { gateRow, shiftRow } from '../setup/security-rows';

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
  let gateId: string;
  let shiftId: string;
  let bundleId: string;
  let envelopeHex: string;
  let batchId: string;
  let actionId: string;
  let flagId: string;

  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(tenantId, () => h.tenantTx.withTenantTx(fn));

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Offline schema');
    guardId = (await createAccountRow(h, tenantId)).id;
    managerId = (await createAccountRow(h, tenantId)).id;
    await inTx(async (tx) => {
      deviceId = await deviceRow(tx, { tenantId, enrolledById: guardId });
      gateId = await gateRow(tx, tenantId);
      shiftId = await shiftRow(tx, { tenantId, guardId, gateId });
      bundleId = await bundleRow(tx, {
        tenantId,
        deviceId,
        shiftId,
        gateId,
        guardId,
      });
      envelopeHex = await envelopeRow(tx, { tenantId, deviceId });
      batchId = await batchRow(tx, {
        tenantId,
        deviceId,
        uploadedById: guardId,
      });
      actionId = await actionRow(tx, {
        tenantId,
        deviceId,
        batchId,
        bundleId,
        guardId,
        shiftId,
        gateId,
      });
      flagId = await flagRow(tx, { tenantId, deviceId, batchId, actionId });
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

  describe('a device’s bundles', () => {
    it('what it downloaded only grows, with when', async () => {
      const set = (sql: string) =>
        `UPDATE gate_devices SET ${sql} WHERE id = '${deviceId}'`;
      await expect(
        asApp(set(`bundle_version = 2, last_bundle_at = ${at(5)}`)),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        asApp(
          set(`bundle_version = 2, last_bundle_at = ${at(5)}`),
          set(`bundle_version = 1`),
        ),
      ).rejects.toThrow(/keeps its key and is revoked once/);
      await expect(
        asApp(
          set(`bundle_version = 2, last_bundle_at = ${at(5)}`),
          set(`last_bundle_at = ${at(4)}`),
        ),
      ).rejects.toThrow(/keeps its key and is revoked once/);
      await expect(asApp(set(`bundle_version = 1`))).rejects.toThrow(
        /gate_devices_bundle_shape/,
      );
    });

    it('a bundle is append-only: never changed, deleted or truncated', async () => {
      expect(await privileges('gate_offline_bundles')).toEqual({
        select: true,
        insert: true,
        update: false,
        delete: false,
        truncate: false,
      });
      await expect(
        asApp(
          `UPDATE gate_offline_bundles SET version = 99 WHERE id = '${bundleId}'`,
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('the shapes of a bundle', async () => {
      const insert = (over: Record<string, string>) => {
        const cols: Record<string, string> = {
          id: 'gen_random_uuid()',
          tenant_id: `'${tenantId}'`,
          device_id: `'${deviceId}'`,
          version: '1000',
          shift_id: `'${shiftId}'`,
          gate_id: `'${gateId}'`,
          guard_account_id: `'${guardId}'`,
          issued_at: at(0),
          valid_until: at(60),
          key_version: '1',
          content_sha256: `'${'b'.repeat(64)}'`,
          counts: `'{}'`,
          ...over,
        };
        return asApp(
          `INSERT INTO gate_offline_bundles (${Object.keys(cols).join(', ')})
           VALUES (${Object.values(cols).join(', ')})`,
        );
      };
      await expect(insert({})).resolves.toMatchObject({ rowCount: 1 });
      await expect(insert({ version: '0' })).rejects.toThrow(
        /gate_offline_bundles_version_positive/,
      );
      await expect(insert({ valid_until: at(0) })).rejects.toThrow(
        /gate_offline_bundles_validity/,
      );
      await expect(insert({ valid_until: at(24 * 60 + 1) })).rejects.toThrow(
        /gate_offline_bundles_validity/,
      );
      await expect(insert({ key_version: '0' })).rejects.toThrow(
        /gate_offline_bundles_key_version/,
      );
      await expect(
        insert({ content_sha256: `'${'B'.repeat(64)}'` }),
      ).rejects.toThrow(/gate_offline_bundles_sha256/);
      await expect(insert({ counts: `'[]'` })).rejects.toThrow(
        /gate_offline_bundles_counts/,
      );
      // Numbered once per device.
      await expect(
        asApp(
          `INSERT INTO gate_offline_bundles
             SELECT gen_random_uuid(), tenant_id, device_id, version, shift_id, gate_id,
                    guard_account_id, issued_at, valid_until, key_version, content_sha256, counts
               FROM gate_offline_bundles WHERE id = '${bundleId}'`,
        ),
      ).rejects.toThrow(/gate_offline_bundles_version_key/);
    });

    it('an envelope is written once, never changed; the sweep deletes it', async () => {
      expect(await privileges('gate_device_envelopes')).toEqual({
        select: true,
        insert: true,
        update: false,
        delete: true,
        truncate: false,
      });
      await expect(
        asApp(
          `DELETE FROM gate_device_envelopes WHERE signature_sha256 = '${envelopeHex}'`,
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        asApp(
          `INSERT INTO gate_device_envelopes (tenant_id, device_id, signature_sha256, sent_at, received_at)
           VALUES ('${tenantId}', '${deviceId}', 'nope', ${at(0)}, ${at(0)})`,
        ),
      ).rejects.toThrow(/gate_device_envelopes_sha256/);
      await expect(
        asApp(
          `INSERT INTO gate_device_envelopes (tenant_id, device_id, signature_sha256, sent_at, received_at)
           VALUES ('${tenantId}', '${deviceId}', '${envelopeHex}', ${at(0)}, ${at(0)})`,
        ),
      ).rejects.toThrow(/gate_device_envelopes_pkey/);
    });
  });

  describe('uploads', () => {
    it('batches and actions are append-only; flags move forward', async () => {
      for (const table of ['gate_offline_batches', 'gate_offline_actions'])
        expect({ table, ...(await privileges(table)) }).toEqual({
          table,
          select: true,
          insert: true,
          update: false,
          delete: false,
          truncate: false,
        });
      expect(await privileges('gate_offline_flags')).toEqual({
        select: true,
        insert: true,
        update: true,
        delete: false,
        truncate: false,
      });
    });

    it('a device’s sequence only grows, and never acknowledges past what it got', async () => {
      const set = (sql: string) =>
        `UPDATE gate_devices SET ${sql} WHERE id = '${deviceId}'`;
      await expect(
        asApp(set('acked_seq = 2, max_seq = 3')),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        asApp(set('acked_seq = 2, max_seq = 3'), set('max_seq = 2')),
      ).rejects.toThrow(/keeps its key and is revoked once/);
      await expect(asApp(set('acked_seq = 4, max_seq = 3'))).rejects.toThrow(
        /gate_devices_seq_shape/,
      );
    });

    it('the shapes of an action', async () => {
      const sql = (over: Record<string, string>) => {
        const cols: Record<string, string> = {
          id: 'gen_random_uuid()',
          tenant_id: `'${tenantId}'`,
          device_id: `'${deviceId}'`,
          batch_id: `'${batchId}'`,
          seq: '900',
          type: `'entry'`,
          content_sha256: `'${'d'.repeat(64)}'`,
          bundle_id: `'${bundleId}'`,
          device_time: at(1),
          occurred_at: at(1),
          received_at: at(2),
          status: `'recorded'`,
          guard_account_id: `'${guardId}'`,
          shift_id: `'${shiftId}'`,
          gate_id: `'${gateId}'`,
          ...over,
        };
        return `INSERT INTO gate_offline_actions (${Object.keys(cols).join(', ')})
                VALUES (${Object.values(cols).join(', ')})`;
      };
      const insert = (over: Record<string, string>) => asApp(sql(over));
      await expect(insert({})).resolves.toMatchObject({ rowCount: 1 });
      await expect(insert({ seq: '0' })).rejects.toThrow(
        /gate_offline_actions_seq_positive/,
      );
      await expect(insert({ type: `'teleport'` })).rejects.toThrow(
        /gate_offline_actions_type/,
      );
      // Recorded: all of when, who, where and which bundle.
      await expect(insert({ shift_id: 'NULL' })).rejects.toThrow(
        /gate_offline_actions_shape/,
      );
      // Rejected: a reason from its list, and nothing recorded.
      await expect(
        insert({ status: `'rejected'`, occurred_at: 'NULL' }),
      ).rejects.toThrow(/gate_offline_actions_shape/);
      await expect(
        insert({
          status: `'rejected'`,
          occurred_at: 'NULL',
          guard_account_id: 'NULL',
          shift_id: 'NULL',
          gate_id: 'NULL',
          reject_reason: `'boredom'`,
        }),
      ).rejects.toThrow(/gate_offline_actions_shape/);
      await expect(
        insert({
          status: `'rejected'`,
          occurred_at: 'NULL',
          guard_account_id: 'NULL',
          shift_id: 'NULL',
          gate_id: 'NULL',
          reject_reason: `'subject_unknown'`,
          entry_id: 'gen_random_uuid()',
        }),
      ).rejects.toThrow(/gate_offline_actions_shape/);
      // One action per sequence number of a device.
      await expect(asApp(sql({}), sql({}))).rejects.toThrow(
        /gate_offline_actions_seq_key/,
      );
    });

    it('a flag: its kind with its class, told, cleared and reviewed once', async () => {
      const where = `id = '${flagId}'`;
      const set = (sql: string) =>
        `UPDATE gate_offline_flags SET ${sql} WHERE ${where}`;
      await expect(asApp(set(`kind = 'lockdown_entered'`))).rejects.toThrow(
        /told, cleared and reviewed once/,
      );
      await expect(
        asApp(set(`alerted_at = ${at(3)}`), set(`alerted_at = ${at(4)}`)),
      ).rejects.toThrow(/told, cleared and reviewed once/);
      const review = set(
        `reviewed_at = ${at(5)}, reviewed_by_account_id = '${managerId}', review_code = 'confirmed'`,
      );
      await expect(asApp(review)).resolves.toMatchObject({ rowCount: 1 });
      await expect(asApp(review, set(`review_code = 'other'`))).rejects.toThrow(
        /told, cleared and reviewed once/,
      );
      await expect(asApp(set(`reviewed_at = ${at(5)}`))).rejects.toThrow(
        /gate_offline_flags_review_shape/,
      );
      // Only an exit's flag is cleared, as reconciled.
      await expect(
        asApp(set(`cleared_at = ${at(5)}, cleared_reason = 'reconciled'`)),
      ).rejects.toThrow(/gate_offline_flags_cleared/);
      const raise = (kind: string, klass: string) =>
        asApp(
          `INSERT INTO gate_offline_flags (id, tenant_id, batch_id, device_id, kind, class, created_at)
           VALUES (gen_random_uuid(), '${tenantId}', '${batchId}', '${deviceId}', '${kind}', '${klass}', ${at(2)})`,
        );
      await expect(raise('lockdown_entered', 'manager')).rejects.toThrow(
        /gate_offline_flags_kind/,
      );
      await expect(
        raise('lockdown_entered', 'security'),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(asApp(set(`params = '[1]'`))).rejects.toThrow(
        /told, cleared and reviewed once|gate_offline_flags_params/,
      );
    });
  });
});
