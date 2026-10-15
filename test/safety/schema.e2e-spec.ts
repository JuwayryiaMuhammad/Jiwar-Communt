import { Client } from 'pg';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import { emergencyRow, familyAlertRow } from '../setup/safety-rows';
import { required } from '../setup/test-env';

/**
 * The emergencies and gate services tables (ADR 0047) at the database: what
 * the app may write, what the triggers keep, and the shapes the CHECKs hold
 * whatever the services do.
 */
describe('Safety tables — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let migrator: Client;
  let tenantId: string;
  let accountId: string;
  let unitId: string;
  let otherUnitId: string;
  let emergencyId: string;

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Safety schema');
    accountId = (await createAccountRow(h, tenantId)).id;
    unitId = (await createUnit(h, tenantId)).id;
    otherUnitId = (await createUnit(h, tenantId)).id;
    await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx: TenantTxClient) => {
        emergencyId = await emergencyRow(tx, {
          tenantId,
          unitId,
          reportedById: accountId,
        });
        await familyAlertRow(tx, { tenantId, emergencyId, accountId });
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
  const where = () => `id = '${emergencyId}'`;
  const accept = `UPDATE emergencies SET status = 'on_the_way', responder_account_id = '${'$ACC'}', eta_minutes = 5, accepted_at = now() WHERE `;
  const accepted = () => accept.replace('$ACC', accountId) + where();

  it('nothing of the domain is deleted or truncated by the app', async () => {
    for (const table of [
      'places',
      'safety_counters',
      'emergencies',
      'emergency_family_alerts',
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

  describe('emergencies', () => {
    it('who reported what, where and when never changes', async () => {
      for (const set of [
        'number = number + 1',
        `unit_id = '${otherUnitId}'`,
        `type = 'fire'`,
        "reported_at = reported_at - interval '1 hour'",
        'responders_notified = 3',
      ])
        await expect(
          asApp(`UPDATE emergencies SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/only moves forward/);
    });

    it('moves forward only; accepted, arrived and closed once; closed is final', async () => {
      // Back to reported.
      await expect(
        asApp(
          accepted(),
          `UPDATE emergencies SET status = 'reported', responder_account_id = NULL, eta_minutes = NULL, accepted_at = NULL WHERE ${where()}`,
        ),
      ).rejects.toThrow(/only moves forward/);
      // Accepted again by someone else, or with other minutes.
      await expect(
        asApp(
          accepted(),
          `UPDATE emergencies SET eta_minutes = 10 WHERE ${where()}`,
        ),
      ).rejects.toThrow(/only moves forward/);
      // Arrived once.
      await expect(
        asApp(
          accepted(),
          `UPDATE emergencies SET status = 'arrived', arrived_at = now() WHERE ${where()}`,
          `UPDATE emergencies SET arrived_at = now() + interval '1 minute' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/only moves forward/);
      // The whole way, then nothing more.
      await expect(
        asApp(
          accepted(),
          `UPDATE emergencies SET status = 'arrived', arrived_at = now() WHERE ${where()}`,
          `UPDATE emergencies SET status = 'resolved', closed_at = now(), closed_by_account_id = '${accountId}', close_side = 'responder', close_reason = 'handled' WHERE ${where()}`,
          `UPDATE emergencies SET close_note = 'Later words' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/only moves forward/);
      // Escalated once.
      await expect(
        asApp(
          `UPDATE emergencies SET escalated_at = now(), escalation_reason = 'timeout' WHERE ${where()}`,
          `UPDATE emergencies SET escalation_reason = 'no_responders' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/only moves forward/);
      // A legal path holds.
      await expect(
        asApp(
          `UPDATE emergencies SET escalated_at = now(), escalation_reason = 'timeout' WHERE ${where()}`,
          accepted(),
          `UPDATE emergencies SET status = 'cancelled', closed_at = now(), closed_by_account_id = '${accountId}', close_side = 'reporter' WHERE ${where()}`,
        ),
      ).resolves.toBeDefined();
    });

    it('is never deleted, even by its owner', async () => {
      await expect(
        attempt(migrator, `DELETE FROM emergencies WHERE ${where()}`),
      ).rejects.toThrow(/never deleted/);
    });

    it.each([
      [
        'eta_minutes = 3 on acceptance',
        () => accepted().replace('eta_minutes = 5', 'eta_minutes = 3'),
        /emergencies_eta/,
      ],
      [
        'on the way without a responder',
        () => `UPDATE emergencies SET status = 'on_the_way' WHERE ${where()}`,
        /emergencies_state_shape/,
      ],
      [
        'a responder without minutes',
        () =>
          `UPDATE emergencies SET status = 'on_the_way', responder_account_id = '${accountId}', accepted_at = now() WHERE ${where()}`,
        /emergencies_accept_shape/,
      ],
      [
        'resolved without a reason',
        () =>
          `UPDATE emergencies SET status = 'resolved', closed_at = now(), closed_by_account_id = '${accountId}', close_side = 'staff' WHERE ${where()}`,
        /emergencies_resolve_reason/,
      ],
      [
        'cancelled with a resolving reason',
        () =>
          `UPDATE emergencies SET status = 'cancelled', closed_at = now(), closed_by_account_id = '${accountId}', close_side = 'reporter', close_reason = 'handled' WHERE ${where()}`,
        /emergencies_cancel_reason/,
      ],
      [
        'cancelled by a responder',
        () =>
          `UPDATE emergencies SET status = 'cancelled', closed_at = now(), closed_by_account_id = '${accountId}', close_side = 'responder' WHERE ${where()}`,
        /emergencies_close_side/,
      ],
      [
        'closed without who',
        () =>
          `UPDATE emergencies SET status = 'cancelled', closed_at = now(), close_side = 'reporter' WHERE ${where()}`,
        /emergencies_close_shape/,
      ],
      [
        'escalated without a reason',
        () => `UPDATE emergencies SET escalated_at = now() WHERE ${where()}`,
        /emergencies_escalation/,
      ],
    ])('refuses %s', async (_what, sql, check) => {
      await expect(asApp(sql())).rejects.toThrow(check);
    });

    it('one open per unit and type; a closed one frees it', async () => {
      const insert = (type: string) =>
        `INSERT INTO emergencies (id, tenant_id, number, unit_id, type, reported_by_account_id, responders_notified, updated_at)
         VALUES (gen_random_uuid(), '${tenantId}', ${800_000 + Math.floor(Math.random() * 99_999)}, '${unitId}', '${type}', '${accountId}', 0, now())`;
      await expect(asApp(insert('medical'))).rejects.toThrow(
        /emergencies_one_open/,
      );
      await expect(asApp(insert('security'))).resolves.toBeDefined();
      await expect(
        asApp(
          `UPDATE emergencies SET status = 'cancelled', closed_at = now(), closed_by_account_id = '${accountId}', close_side = 'reporter' WHERE ${where()}`,
          insert('medical'),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('emergency family alerts', () => {
    const alert = () =>
      `emergency_id = '${emergencyId}' AND account_id = '${accountId}'`;

    it('answered once; never moved, never deleted', async () => {
      await expect(
        asApp(
          `UPDATE emergency_family_alerts SET on_my_way_at = now() WHERE ${alert()}`,
        ),
      ).resolves.toBeDefined();
      await expect(
        asApp(
          `UPDATE emergency_family_alerts SET on_my_way_at = now() WHERE ${alert()}`,
          `UPDATE emergency_family_alerts SET on_my_way_at = NULL WHERE ${alert()}`,
        ),
      ).rejects.toThrow(/answered once/);
      await expect(
        asApp(
          `UPDATE emergency_family_alerts SET notified_at = now() - interval '1 day' WHERE ${alert()}`,
        ),
      ).rejects.toThrow(/answered once/);
      await expect(
        attempt(
          migrator,
          `DELETE FROM emergency_family_alerts WHERE ${alert()}`,
        ),
      ).rejects.toThrow(/never deleted/);
    });
  });
});
