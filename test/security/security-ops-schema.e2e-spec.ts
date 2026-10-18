import { Client } from 'pg';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { newId } from '../../src/core/common/uuid';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import {
  blocklistRow,
  lockdownRow,
  overrideRow,
  personRow,
} from '../setup/security-ops-rows';
import { gateRow, shiftRow } from '../setup/security-rows';
import { required } from '../setup/test-env';

/**
 * The security tables of ADR 0053 at the database: what the app may write,
 * what the triggers keep, and the shapes the CHECKs hold whatever the
 * services do.
 */
describe('Security tables (ADR 0053) — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let migrator: Client;
  let tenantId: string;
  let guardId: string;
  let managerId: string;
  let gateId: string;
  let otherGateId: string;
  let shiftId: string;
  let liveId: string;
  let endedId: string;
  let plateEntryId: string;
  let personEntryId: string;

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Security schema');
    guardId = (await createAccountRow(h, tenantId)).id;
    managerId = (await createAccountRow(h, tenantId)).id;
    await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx: TenantTxClient) => {
        gateId = await gateRow(tx, tenantId);
        otherGateId = await gateRow(tx, tenantId);
        shiftId = await shiftRow(tx, { tenantId, guardId, gateId });
        liveId = await lockdownRow(tx, {
          tenantId,
          gateId,
          guardId,
          shiftId,
          live: true,
        });
        endedId = await lockdownRow(tx, { tenantId, gateId, guardId, shiftId });
        plateEntryId = await blocklistRow(tx, {
          tenantId,
          createdById: managerId,
        });
        personEntryId = await personRow(tx, {
          tenantId,
          createdById: managerId,
        });
        await overrideRow(tx, {
          tenantId,
          lockdownId: liveId,
          gateId,
          shiftId,
          guardId,
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

  it('the app updates (or locks) but never deletes or truncates what is kept', async () => {
    for (const table of [
      'gate_lockdown_states',
      'gate_lockdowns',
      'blocklist_entries',
    ])
      expect({ table, ...(await privileges(table)) }).toEqual({
        table,
        select: true,
        insert: true,
        update: true,
        delete: false,
        truncate: false,
      });
  });

  it('what is only ever added is neither changed nor deleted by the app', async () => {
    for (const table of ['gate_lockdown_overrides'])
      expect({ table, ...(await privileges(table)) }).toEqual({
        table,
        select: true,
        insert: true,
        update: false,
        delete: false,
        truncate: false,
      });
  });

  it('nothing kept is deleted or truncated, even by the owner', async () => {
    for (const table of [
      'gate_lockdown_states',
      'gate_lockdowns',
      'gate_lockdown_overrides',
      'blocklist_entries',
    ]) {
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
      ).rejects.toThrow(/never deleted|append-only|only locked/);
      await expect(
        attempt(migrator, `TRUNCATE "${table}" CASCADE`),
      ).rejects.toThrow(/append-only|immutable|never/);
    }
  });

  describe('gate_lockdown_states', () => {
    it('is locked, never changed', async () => {
      await expect(
        asApp(
          `SELECT tenant_id FROM gate_lockdown_states WHERE tenant_id = '${tenantId}' FOR UPDATE`,
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        asApp(
          `UPDATE gate_lockdown_states SET created_at = now() WHERE tenant_id = '${tenantId}'`,
        ),
      ).rejects.toThrow(/only locked/);
    });
  });

  describe('gate_lockdowns', () => {
    const where = (id: string) => `id = '${id}'`;
    const end = (id: string) =>
      `UPDATE gate_lockdowns SET ended_at = now(), ended_by_account_id = '${managerId}', end_reason = 'threat_cleared' WHERE ${where(id)}`;

    it('is ended once; an ended one never changes again', async () => {
      await expect(asApp(end(liveId))).resolves.toMatchObject({
        rowCount: 1,
      });
      await expect(asApp(end(endedId))).rejects.toThrow(/ended once/);
      await expect(
        asApp(
          `UPDATE gate_lockdowns SET end_note = 'later' WHERE ${where(endedId)}`,
        ),
      ).rejects.toThrow(/ended once/);
    });

    it('what started it never changes', async () => {
      for (const set of [
        `gate_id = '${otherGateId}'`,
        `gate_id = NULL`,
        `reason_code = 'fire'`,
        `started_at = now()`,
        `started_by_account_id = '${managerId}'`,
      ])
        await expect(
          asApp(`UPDATE gate_lockdowns SET ${set} WHERE ${where(liveId)}`),
        ).rejects.toThrow(/ended once/);
    });

    it('one live per scope, "all" included; an end comes with who and why', async () => {
      const insert = (gate: string | null) =>
        `INSERT INTO gate_lockdowns (id, tenant_id, gate_id, reason_code, started_by_account_id, started_shift_id, started_at, updated_at)
         VALUES ('${newId()}', '${tenantId}', ${gate ? `'${gate}'` : 'NULL'}, 'drill', '${guardId}', '${shiftId}', now(), now())`;
      await expect(asApp(insert(gateId))).rejects.toThrow(
        /gate_lockdowns_one_live/,
      );
      await expect(asApp(insert(null), insert(null))).rejects.toThrow(
        /gate_lockdowns_one_live/,
      );
      await expect(
        asApp(insert(otherGateId), insert(null)),
      ).resolves.toBeDefined();
      await expect(
        asApp(
          `UPDATE gate_lockdowns SET ended_at = now() WHERE ${where(liveId)}`,
        ),
      ).rejects.toThrow(/gate_lockdowns_end_shape/);
      await expect(
        asApp(
          `UPDATE gate_lockdowns SET end_note = 'early' WHERE ${where(liveId)}`,
        ),
      ).rejects.toThrow(/gate_lockdowns_end_shape/);
      await expect(
        asApp(
          `UPDATE gate_lockdowns SET ended_at = now(), ended_by_account_id = '${managerId}', end_reason = 'bored' WHERE ${where(liveId)}`,
        ),
      ).rejects.toThrow(/gate_lockdowns_end_reason/);
      await expect(
        asApp(
          `INSERT INTO gate_lockdowns (id, tenant_id, gate_id, reason_code, started_by_account_id, started_shift_id, started_at, updated_at)
           VALUES ('${newId()}', '${tenantId}', '${otherGateId}', 'boredom', '${guardId}', '${shiftId}', now(), now())`,
        ),
      ).rejects.toThrow(/gate_lockdowns_reason/);
    });
  });

  describe('blocklist_entries', () => {
    const where = (id: string) => `id = '${id}'`;
    const lift = (id: string) =>
      `UPDATE blocklist_entries SET lifted_at = now(), lifted_by_account_id = '${managerId}', lift_reason = 'resolved' WHERE ${where(id)}`;
    const purge = (id: string) =>
      `UPDATE blocklist_entries SET full_name = NULL, id_hash = NULL, photo_file_id = NULL, note = NULL, purged_at = now() WHERE ${where(id)}`;

    it('its subject never changes; what it says does while live', async () => {
      for (const set of [
        `plate = 'OTHER 1'`,
        `subject = 'person'`,
        `created_at = now()`,
      ])
        await expect(
          asApp(
            `UPDATE blocklist_entries SET ${set} WHERE ${where(plateEntryId)}`,
          ),
        ).rejects.toThrow(/keeps its subject/);
      for (const set of [
        `full_name = 'Someone else'`,
        `id_hash = repeat('a', 64)`,
      ])
        await expect(
          asApp(
            `UPDATE blocklist_entries SET ${set} WHERE ${where(personEntryId)}`,
          ),
        ).rejects.toThrow(/keeps its subject/);
      await expect(
        asApp(
          `UPDATE blocklist_entries SET kind = 'watch', note = 'n', expires_at = now() + interval '1 day' WHERE ${where(plateEntryId)}`,
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    });

    it('lifted once; then only the one purge, of a person, after which nothing changes', async () => {
      await expect(
        asApp(lift(plateEntryId), lift(plateEntryId)),
      ).rejects.toThrow(/keeps its subject/);
      await expect(
        asApp(
          lift(plateEntryId),
          `UPDATE blocklist_entries SET note = 'x' WHERE ${where(plateEntryId)}`,
        ),
      ).rejects.toThrow(/keeps its subject/);
      // A plate is never purged.
      await expect(
        asApp(
          lift(plateEntryId),
          `UPDATE blocklist_entries SET purged_at = now() WHERE ${where(plateEntryId)}`,
        ),
      ).rejects.toThrow(/blocklist_entries_subject_shape/);
      // Never purged while live.
      await expect(asApp(purge(personEntryId))).rejects.toThrow(
        /keeps its subject/,
      );
      await expect(
        asApp(lift(personEntryId), purge(personEntryId)),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        asApp(lift(personEntryId), purge(personEntryId), purge(personEntryId)),
      ).rejects.toThrow(/keeps its subject/);
      // A purge clears everything of the person, together.
      await expect(
        asApp(
          lift(personEntryId),
          `UPDATE blocklist_entries SET id_hash = NULL, purged_at = now() WHERE ${where(personEntryId)}`,
        ),
      ).rejects.toThrow(/blocklist_entries_purge_shape/);
    });

    it('the shapes: a plate carries nothing of a person, a person no plate; one live per plate and per person', async () => {
      const insert = (cols: string, values: string) =>
        `INSERT INTO blocklist_entries (id, tenant_id, kind, subject, reason_code, created_by_account_id, updated_at, ${cols})
         VALUES ('${newId()}', '${tenantId}', 'ban', ${values.split('|')[0]}, 'other', '${managerId}', now(), ${values.split('|')[1]})`;
      await expect(
        asApp(insert('plate, full_name', `'plate'|'SHAPE 1', 'A Name'`)),
      ).rejects.toThrow(/blocklist_entries_subject_shape/);
      await expect(
        asApp(insert('full_name', `'person'|'No Hash'`)),
      ).rejects.toThrow(/blocklist_entries_subject_shape/);
      await expect(
        asApp(insert('full_name, id_hash', `'person'|'Bad Hash', 'XYZ'`)),
      ).rejects.toThrow(/blocklist_entries_id_hash_shape/);
      const plate = (await asApp(
        `SELECT plate FROM blocklist_entries WHERE ${where(plateEntryId)}`,
      ))!.rows[0] as { plate: string };
      await expect(
        asApp(insert('plate', `'plate'|'${plate.plate.replace(' ', '')}'`)),
      ).rejects.toThrow(/blocklist_entries_live_plate_key/);
      await expect(
        asApp(
          `INSERT INTO blocklist_entries (id, tenant_id, kind, subject, reason_code, created_by_account_id, updated_at, plate)
           VALUES ('${newId()}', '${tenantId}', 'ban', 'plate', 'gossip', '${managerId}', now(), 'SHAPE 2')`,
        ),
      ).rejects.toThrow(/blocklist_entries_reason/);
      await expect(
        asApp(
          `UPDATE blocklist_entries SET lifted_at = now(), lift_reason = 'resolved' WHERE ${where(plateEntryId)}`,
        ),
      ).rejects.toThrow(/blocklist_entries_lift_shape/);
      await expect(
        asApp(
          `UPDATE blocklist_entries SET lifted_at = now(), lifted_by_account_id = '${managerId}', lift_reason = 'expired' WHERE ${where(plateEntryId)}`,
        ),
      ).rejects.toThrow(/blocklist_entries_lift_shape/);
    });
  });

  describe('gate_lockdown_overrides', () => {
    it('takes the closed list of vehicles only', async () => {
      await expect(
        asApp(
          `INSERT INTO gate_lockdown_overrides (id, tenant_id, lockdown_id, gate_id, shift_id, guard_account_id, kind, occurred_at)
           VALUES ('${newId()}', '${tenantId}', '${liveId}', '${gateId}', '${shiftId}', '${guardId}', 'taxi', now())`,
        ),
      ).rejects.toThrow(/gate_lockdown_overrides_kind/);
    });
  });
});
