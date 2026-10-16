import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import { gateRow, slotRow, templateRow } from '../setup/security-rows';
import { required } from '../setup/test-env';

/**
 * The guard shifts and tasks tables (ADR 0050) at the database: what the
 * app may write, what the triggers keep, and the shapes the CHECKs hold
 * whatever the services do.
 */
describe('Guard duty tables — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let migrator: Client;
  let tenantId: string;
  let guardId: string;
  let otherId: string;
  let gateId: string;
  let otherGateId: string;
  let templateId: string;
  let slotId: string;
  let shiftId: string;

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Guard duty schema');
    guardId = (await createAccountRow(h, tenantId)).id;
    otherId = (await createAccountRow(h, tenantId)).id;
    await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx: TenantTxClient) => {
        gateId = await gateRow(tx, tenantId);
        otherGateId = await gateRow(tx, tenantId);
        templateId = await templateRow(tx, {
          tenantId,
          guardId,
          gateId,
          createdById: otherId,
        });
        slotId = await slotRow(tx, {
          tenantId,
          guardId,
          gateId,
          createdById: otherId,
        });
        shiftId = newId();
        await tx.guardShift.create({
          data: {
            id: shiftId,
            tenantId,
            guardAccountId: guardId,
            gateId,
            startedAt: new Date(Date.now() - 3_600_000),
          },
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

  it('nothing of the domain is deleted or truncated by the app', async () => {
    for (const table of [
      'guard_shifts',
      'guard_roster_templates',
      'guard_roster_slots',
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

  it('nothing is deleted or truncated, even by the owner', async () => {
    for (const table of [
      'guard_shifts',
      'guard_roster_templates',
      'guard_roster_slots',
    ]) {
      await expect(
        attempt(
          migrator,
          `DELETE FROM "${table}" WHERE tenant_id = '${tenantId}'`,
        ),
      ).rejects.toThrow(/never deleted/);
      await expect(
        attempt(migrator, `TRUNCATE "${table}" CASCADE`),
      ).rejects.toThrow(/append-only|immutable|never/);
    }
  });

  describe('guard_shifts', () => {
    const where = () => `id = '${shiftId}'`;
    const end = () =>
      `UPDATE guard_shifts SET ended_at = now(), end_reason = 'guard' WHERE ${where()}`;

    it('who, where and when never change', async () => {
      for (const set of [
        `guard_account_id = '${otherId}'`,
        `gate_id = '${otherGateId}'`,
        "started_at = started_at - interval '1 hour'",
      ])
        await expect(
          asApp(`UPDATE guard_shifts SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/keeps who, where and when/);
    });

    it('ends once; what the end records is written once, at the end only', async () => {
      await expect(
        asApp(`UPDATE guard_shifts SET overtime_minutes = 5 WHERE ${where()}`),
      ).rejects.toThrow(/guard_shifts_minutes_at_end/);
      await expect(
        asApp(
          end(),
          `UPDATE guard_shifts SET overtime_minutes = 5, unscheduled_minutes = 5 WHERE ${where()}`,
        ),
      ).rejects.toThrow(/guard_shifts_minutes_at_end/);
      await expect(
        asApp(
          end(),
          `UPDATE guard_shifts SET overtime_minutes = 5 WHERE ${where()}`,
          `UPDATE guard_shifts SET overtime_minutes = 6 WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps who, where and when/);
      await expect(
        asApp(
          end(),
          `UPDATE guard_shifts SET ended_at = now() + interval '1 minute' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps who, where and when/);
      await asApp(
        end(),
        `UPDATE guard_shifts SET unscheduled_minutes = 60 WHERE ${where()}`,
      );
    });

    it('one post, exactly', async () => {
      const id = newId();
      await expect(
        asApp(
          `INSERT INTO guard_shifts (id, tenant_id, guard_account_id) VALUES ('${id}', '${tenantId}', '${otherId}')`,
        ),
      ).rejects.toThrow(/guard_shifts_one_post/);
    });
  });

  describe('guard_roster_templates', () => {
    const where = () => `id = '${templateId}'`;

    it('keeps what it says; ended once', async () => {
      for (const set of [
        `guard_account_id = '${otherId}'`,
        `gate_id = '${otherGateId}'`,
        `schedule = '{"days":[2],"windows":[]}'`,
        'effective_from = effective_from + 1',
        "effective_until = '2031-01-01'",
      ])
        await expect(
          asApp(`UPDATE guard_roster_templates SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/keeps what it says/);
      const ended = `UPDATE guard_roster_templates SET ended_at = now(), end_reason = 'manager', ended_by_account_id = '${otherId}' WHERE ${where()}`;
      await asApp(ended);
      await expect(
        asApp(
          ended,
          `UPDATE guard_roster_templates SET end_reason = 'guard_left', ended_by_account_id = NULL WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps what it says/);
    });

    it('its end names who for the management, nobody for the system', async () => {
      await expect(
        asApp(
          `UPDATE guard_roster_templates SET ended_at = now(), end_reason = 'manager' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/guard_roster_templates_end_by/);
      await expect(
        asApp(
          `UPDATE guard_roster_templates SET ended_at = now(), end_reason = 'guard_left', ended_by_account_id = '${otherId}' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/guard_roster_templates_end_by/);
      await expect(
        asApp(
          `UPDATE guard_roster_templates SET ended_at = now(), end_reason = 'bored' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/guard_roster_templates_end_reason/);
    });
  });

  describe('guard_roster_slots', () => {
    const where = () => `id = '${slotId}'`;
    const cancel = (reason = 'other', by: string | null = otherId) =>
      `UPDATE guard_roster_slots SET status = 'cancelled', cancelled_at = now(), cancel_reason = '${reason}', cancelled_by_account_id = ${by ? `'${by}'` : 'NULL'} WHERE ${where()}`;
    const fill = () =>
      `UPDATE guard_roster_slots SET shift_id = '${shiftId}', late_minutes = 3 WHERE ${where()}`;

    it('keeps its post and its times', async () => {
      for (const set of [
        `gate_id = '${otherGateId}'`,
        "starts_at = starts_at + interval '1 minute'",
        "ends_at = ends_at + interval '1 minute'",
        `template_id = '${templateId}'`,
      ])
        await expect(
          asApp(`UPDATE guard_roster_slots SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/keeps its post and times/);
    });

    it('cancelled once, and then nothing changes', async () => {
      await asApp(cancel());
      await expect(
        asApp(
          cancel(),
          `UPDATE guard_roster_slots SET absent_at = now() WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps its post and times/);
      await expect(asApp(cancel('template_ended', otherId))).rejects.toThrow(
        /guard_roster_slots_cancelled_by/,
      );
      await expect(asApp(cancel('other', null))).rejects.toThrow(
        /guard_roster_slots_cancelled_by/,
      );
      await expect(asApp(cancel('lazy'))).rejects.toThrow(
        /guard_roster_slots_cancel_reason/,
      );
    });

    it('filled once, with its lateness; a filled slot is not cancelled; absent once', async () => {
      await asApp(fill());
      await expect(
        asApp(
          fill(),
          `UPDATE guard_roster_slots SET late_minutes = 4 WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps its post and times/);
      await expect(asApp(fill(), cancel())).rejects.toThrow(
        /guard_roster_slots_filled_shape/,
      );
      await expect(
        asApp(
          `UPDATE guard_roster_slots SET shift_id = '${shiftId}' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/guard_roster_slots_filled_shape/);
      await expect(
        asApp(
          `UPDATE guard_roster_slots SET absent_at = now() WHERE ${where()}`,
          `UPDATE guard_roster_slots SET absent_at = now() + interval '1 minute' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps its post and times/);
    });

    it('changes guard only by a swap, while unopened', async () => {
      await expect(
        asApp(
          `UPDATE guard_roster_slots SET guard_account_id = '${otherId}' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps its post and times/);
      await asApp(
        `UPDATE guard_roster_slots SET guard_account_id = '${otherId}', swapped_at = now() WHERE ${where()}`,
      );
      await expect(
        asApp(
          fill(),
          `UPDATE guard_roster_slots SET guard_account_id = '${otherId}', swapped_at = now() WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps its post and times/);
    });

    it('a day at most, after its start, made by someone or a template', async () => {
      const insert = (starts: string, ends: string, by: string | null) =>
        asApp(
          `INSERT INTO guard_roster_slots (id, tenant_id, guard_account_id, gate_id, starts_at, ends_at, created_by_account_id, updated_at)
           VALUES ('${newId()}', '${tenantId}', '${otherId}', '${gateId}', ${starts}, ${ends}, ${by ? `'${by}'` : 'NULL'}, now())`,
        );
      await expect(
        insert('now()', "now() + interval '25 hours'", otherId),
      ).rejects.toThrow(/guard_roster_slots_at_most_a_day/);
      await expect(insert('now()', 'now()', otherId)).rejects.toThrow(
        /guard_roster_slots_ends_after_start/,
      );
      await expect(
        insert('now()', "now() + interval '1 hour'", null),
      ).rejects.toThrow(/guard_roster_slots_made_by/);
    });
  });
});
