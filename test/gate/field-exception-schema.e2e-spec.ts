import { Client } from 'pg';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  fieldExceptionRow,
  rowAt,
  visitorDetailsRow,
} from '../setup/gate-completion-rows';
import { gateRow, shiftRow } from '../setup/security-rows';

/**
 * The field exceptions' and the gate settings' tables (ADR 0056) at the
 * database: what the app may write; what was asked never changes; an
 * exception is decided once and used once, within its window; the shapes
 * the CHECKs hold whatever the services do. Every instant is written out.
 */
describe('Field exceptions and gate settings — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let tenantId: string;
  let guardId: string;
  let managerId: string;
  let otherId: string;
  let unitId: string;
  let gateId: string;
  let shiftId: string;
  let exceptionId: string;
  let withDetailsId: string;
  let detailsId: string;

  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(tenantId, () => h.tenantTx.withTenantTx(fn));

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Field exception schema');
    guardId = (await createAccountRow(h, tenantId)).id;
    managerId = (await createAccountRow(h, tenantId)).id;
    otherId = (await createAccountRow(h, tenantId)).id;
    unitId = (await createUnit(h, tenantId)).id;
    await inTx(async (tx) => {
      gateId = await gateRow(tx, tenantId);
      shiftId = await shiftRow(tx, { tenantId, guardId, gateId });
      const r = { tenantId, gateId, shiftId, guardId, unitId };
      exceptionId = await fieldExceptionRow(tx, r);
      detailsId = await visitorDetailsRow(tx, tenantId);
      withDetailsId = await fieldExceptionRow(tx, {
        ...r,
        visitorDetailsId: detailsId,
      });
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
  const at = (minutes: number) => `'${rowAt(minutes).toISOString()}'`;
  const where = () => `id = '${exceptionId}'`;
  const approve = () =>
    `UPDATE gate_field_exceptions SET status = 'approved', decided_at = ${at(2)},
       decided_by_account_id = '${managerId}', entry_until = ${at(17)} WHERE ${where()}`;

  it('the app reads, adds and moves them on; it never deletes or truncates', async () => {
    for (const table of ['gate_field_exceptions', 'gate_settings'])
      expect({ table, ...(await privileges(table)) }).toEqual({
        table,
        select: true,
        insert: true,
        update: true,
        delete: false,
        truncate: false,
      });
    await expect(
      asApp(`DELETE FROM gate_field_exceptions WHERE ${where()}`),
    ).rejects.toThrow(/permission denied/);
  });

  describe('a field exception', () => {
    it('what was asked never changes', async () => {
      for (const set of [
        `kind = 'unregistered_vehicle'`,
        `reason_code = 'emergency'`,
        `unit_id = gen_random_uuid()`,
        `raised_by_account_id = '${otherId}'`,
        `raised_at = ${at(1)}`,
        `answer_by = ${at(11)}`,
        `number = number + 1`,
      ])
        await expect(
          asApp(`UPDATE gate_field_exceptions SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/what was asked never changes/);
    });

    it('is decided once: never again, never otherwise', async () => {
      await expect(asApp(approve())).resolves.toMatchObject({ rowCount: 1 });
      for (const set of [
        `status = 'rejected', reject_reason_code = 'other', entry_until = NULL`,
        `decided_at = ${at(3)}`,
        `decided_by_account_id = '${otherId}'`,
        `entry_until = ${at(20)}`,
        `status = 'pending', decided_at = NULL, decided_by_account_id = NULL, entry_until = NULL`,
      ])
        await expect(
          asApp(
            approve(),
            `UPDATE gate_field_exceptions SET ${set} WHERE ${where()}`,
          ),
        ).rejects.toThrow(/decided and used once/);
    });

    it('is used once, by an approval, within its window', async () => {
      const use = (minutes: number) =>
        `UPDATE gate_field_exceptions SET used_at = ${at(minutes)},
           used_entry_id = gen_random_uuid() WHERE ${where()}`;
      await expect(asApp(approve(), use(5))).resolves.toMatchObject({
        rowCount: 1,
      });
      await expect(asApp(approve(), use(5), use(6))).rejects.toThrow(
        /decided and used once/,
      );
      await expect(asApp(use(5))).rejects.toThrow(
        /gate_field_exceptions_used_shape/,
      );
      await expect(asApp(approve(), use(18))).rejects.toThrow(
        /gate_field_exceptions_used_shape/,
      );
      await expect(asApp(approve(), use(1))).rejects.toThrow(
        /gate_field_exceptions_used_shape/,
      );
    });

    it('the shapes of a decision', async () => {
      const set = (sql: string) =>
        asApp(`UPDATE gate_field_exceptions SET ${sql} WHERE ${where()}`);
      // Approved: someone, and a window after the decision.
      await expect(
        set(
          `status = 'approved', decided_at = ${at(2)}, decided_by_account_id = '${managerId}'`,
        ),
      ).rejects.toThrow(/gate_field_exceptions_decision_shape/);
      await expect(
        set(
          `status = 'approved', decided_at = ${at(2)}, decided_by_account_id = '${managerId}', entry_until = ${at(2)}`,
        ),
      ).rejects.toThrow(/gate_field_exceptions_decision_shape/);
      // Rejected: a reason; expired: nobody; pending: nothing decided.
      await expect(
        set(
          `status = 'rejected', decided_at = ${at(2)}, decided_by_account_id = '${managerId}'`,
        ),
      ).rejects.toThrow(/gate_field_exceptions_decision_shape/);
      await expect(
        set(
          `status = 'expired', decided_at = ${at(10)}, decided_by_account_id = '${managerId}'`,
        ),
      ).rejects.toThrow(/gate_field_exceptions_decision_shape/);
      await expect(
        set(`status = 'expired', decided_at = ${at(10)}`),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(set(`decided_at = ${at(2)}`)).rejects.toThrow(
        /gate_field_exceptions_decision_shape/,
      );
      await expect(
        set(
          `status = 'rejected', decided_at = ${at(2)}, decided_by_account_id = '${managerId}', reject_reason_code = 'bribe'`,
        ),
      ).rejects.toThrow(/gate_field_exceptions_reject_reason/);
    });

    it('a worker’s names one worker and nothing of a visitor', async () => {
      await expect(
        asApp(
          `INSERT INTO gate_field_exceptions (id, tenant_id, number, kind, reason_code, gate_id, shift_id,
              raised_by_account_id, unit_id, raised_at, answer_by)
           VALUES (gen_random_uuid(), '${tenantId}', 1, 'worker_outside_hours', 'other', '${gateId}', '${shiftId}',
              '${guardId}', '${unitId}', ${at(0)}, ${at(10)})`,
        ),
      ).rejects.toThrow(/gate_field_exceptions_worker_shape/);
    });

    it('the visitor’s details go when they expire, and never come back', async () => {
      await expect(
        asApp(
          `DELETE FROM visitor_details WHERE id = '${detailsId}'`,
          `SELECT visitor_details_id FROM gate_field_exceptions WHERE id = '${withDetailsId}'`,
        ),
      ).resolves.toMatchObject({ rows: [{ visitor_details_id: null }] });
      await expect(
        asApp(
          `DELETE FROM visitor_details WHERE id = '${detailsId}'`,
          `UPDATE gate_field_exceptions SET visitor_details_id = '${detailsId}' WHERE id = '${withDetailsId}'`,
        ),
      ).rejects.toThrow(/what was asked never changes|foreign key/);
    });
  });

  it('an entry on an exception is recorded by `exception`, and only such an entry', async () => {
    const insert = (method: string, subject: string, exception: string) =>
      asApp(
        `INSERT INTO gate_entries (id, tenant_id, gate_id, shift_id, guard_account_id, subject_type, subject_id,
            unit_id, direction, method, occurred_at, field_exception_id)
         VALUES (gen_random_uuid(), '${tenantId}', '${gateId}', '${shiftId}', '${guardId}', '${subject}',
            '${exceptionId}', '${unitId}', 'in', '${method}', ${at(5)}, ${exception})`,
      );
    await expect(
      insert('exception', 'field_exception', `'${exceptionId}'`),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      insert('exception', 'field_exception', 'NULL'),
    ).rejects.toThrow(/gate_entries_exception_shape/);
    await expect(insert('code', 'field_exception', 'NULL')).rejects.toThrow(
      /gate_entries_exception_shape/,
    );
    await expect(
      insert('code', 'visitor_pass', `'${exceptionId}'`),
    ).rejects.toThrow(/gate_entries_exception_shape/);
  });

  it('the settings stay within their bounds', async () => {
    for (const set of [
      'exception_answer_minutes = 0',
      'exception_answer_minutes = 61',
      'exception_entry_minutes = 4',
      'exception_entry_minutes = 121',
    ])
      await expect(
        asApp(
          `UPDATE gate_settings SET ${set} WHERE tenant_id = '${tenantId}'`,
        ),
      ).rejects.toThrow(/gate_settings_exception/);
    await expect(
      asApp(`DELETE FROM gate_settings WHERE tenant_id = '${tenantId}'`),
    ).rejects.toThrow(/permission denied/);
  });
});
