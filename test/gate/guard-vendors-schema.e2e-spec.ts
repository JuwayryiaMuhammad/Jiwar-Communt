import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import { gateRow, shiftRow } from '../setup/security-rows';
import { personRow } from '../setup/security-ops-rows';

/**
 * The guard vendor adapters' tables (ADR 0068) at the database: what the
 * app may write, and the shapes and moves the CHECKs and triggers hold
 * whatever the services do. Each statement runs as the app and is rolled
 * back.
 */
describe('The guard vendors’ tables — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let tenantId: string;
  let guardId: string;
  let gateId: string;
  let shiftId: string;
  let entryId: string;

  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(tenantId, () => h.tenantTx.withTenantTx(fn));

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Guard vendors schema');
    guardId = (await createAccountRow(h, tenantId)).id;
    await inTx(async (tx) => {
      gateId = await gateRow(tx, tenantId);
      shiftId = await shiftRow(tx, { tenantId, guardId, gateId });
      entryId = await personRow(tx, { tenantId, createdById: guardId });
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
  const SELECT_INSERT_UPDATE = {
    select: true,
    insert: true,
    update: true,
    delete: false,
    truncate: false,
  };

  describe('a face enrolment', () => {
    const id = newId();
    const insert = (cols = '', values = '') =>
      `INSERT INTO gate_face_enrollments (id, tenant_id, entry_id${cols})
       VALUES ('${id}', '${tenantId}', '${entryId}'${values})`;
    const set = (sql: string) =>
      `UPDATE gate_face_enrollments SET ${sql} WHERE id = '${id}'`;
    const enrolled = set(
      `status = 'enrolled', template_ref = 'tpl-1', enrolled_at = now()`,
    );
    const removing = set(`status = 'removing', removing_at = now()`);
    const removed = set(
      `status = 'removed', template_ref = NULL, removed_at = now()`,
    );

    it('the app reads, writes and moves it; it never deletes or truncates', async () => {
      expect(await privileges('gate_face_enrollments')).toEqual(
        SELECT_INSERT_UPDATE,
      );
      await expect(
        asApp(insert(), `DELETE FROM gate_face_enrollments WHERE id = '${id}'`),
      ).rejects.toThrow(/permission denied/);
    });

    it('moves forward: pending → enrolled → removing → removed, or pending → removing', async () => {
      await expect(
        asApp(insert(), enrolled, removing, removed),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(asApp(insert(), removing, removed)).resolves.toMatchObject({
        rowCount: 1,
      });
      for (const back of [
        [enrolled, set(`status = 'pending'`)],
        [removing, set(`status = 'enrolled'`)],
        [removing, removed, set(`status = 'removing'`)],
        [enrolled, set(`entry_id = '${newId()}'`)],
        [enrolled, set(`enrolled_at = now() + interval '1 hour'`)],
      ])
        await expect(asApp(insert(), ...back)).rejects.toThrow(
          /only moves forward/,
        );
    });

    it('one live a entry; each status its shape', async () => {
      await expect(
        asApp(
          insert(),
          `INSERT INTO gate_face_enrollments (id, tenant_id, entry_id)
           VALUES ('${newId()}', '${tenantId}', '${entryId}')`,
        ),
      ).rejects.toThrow(/gate_face_enrollments_live_key/);
      // A removing one beside a new live one is how a photo is replaced.
      await expect(
        asApp(
          insert(),
          removing,
          `INSERT INTO gate_face_enrollments (id, tenant_id, entry_id)
           VALUES ('${newId()}', '${tenantId}', '${entryId}')`,
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      for (const [sql, check] of [
        [set(`status = 'enrolled'`), 'shape'],
        [set(`status = 'removing'`), 'shape'],
        [set(`last_error = 'vendor said no'`), 'error'],
        [set(`template_ref = ''`), 'template'],
        [set(`attempts = -1`), 'shape'],
      ])
        await expect(asApp(insert(), sql)).rejects.toThrow(
          new RegExp(`gate_face_enrollments_${check}`),
        );
      await expect(
        asApp(
          insert(),
          enrolled,
          removing,
          set(`status = 'removed', removed_at = now()`),
        ),
      ).rejects.toThrow(/gate_face_enrollments_shape/);
      await expect(asApp(insert(`, status`, `, 'gone'`))).rejects.toThrow(
        /gate_face_enrollments_status/,
      );
    });
  });

  describe('a face check', () => {
    const id = newId();
    const insert = () =>
      `INSERT INTO gate_face_checks (id, tenant_id, shift_id, gate_id, guard_account_id, probe_deleted_at)
       VALUES ('${id}', '${tenantId}', '${shiftId}', '${gateId}', '${guardId}', now())`;
    const set = (sql: string) =>
      `UPDATE gate_face_checks SET ${sql} WHERE id = '${id}'`;
    const answer = (outcome: string, matches: number) =>
      set(`outcome = '${outcome}', matches = ${matches}, checked_at = now()`);

    it('the app reads, writes and answers it; it never deletes or truncates', async () => {
      expect(await privileges('gate_face_checks')).toEqual(
        SELECT_INSERT_UPDATE,
      );
    });

    it('is answered once, its count fitting its outcome', async () => {
      await expect(
        asApp(insert(), answer('possible_match', 2)),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        asApp(insert(), answer('no_match', 0), answer('possible_match', 1)),
      ).rejects.toThrow(/answered once/);
      await expect(
        asApp(insert(), set(`shift_id = '${newId()}'`)),
      ).rejects.toThrow(/answered once/);
      for (const [outcome, matches] of [
        ['possible_match', 0],
        ['no_match', 1],
        ['unavailable', 3],
      ] as const)
        await expect(asApp(insert(), answer(outcome, matches))).rejects.toThrow(
          /gate_face_checks_shape/,
        );
      await expect(
        asApp(insert(), set(`outcome = 'no_match'`)),
      ).rejects.toThrow(/gate_face_checks_shape/);
      await expect(asApp(insert(), answer('matched', 1))).rejects.toThrow(
        /gate_face_checks_outcome/,
      );
    });

    it('a probe is held, or gone with its day', async () => {
      await expect(
        asApp(insert(), set(`probe_deleted_at = NULL`)),
      ).rejects.toThrow(/gate_face_checks_shape|answered once/);
    });
  });
});
