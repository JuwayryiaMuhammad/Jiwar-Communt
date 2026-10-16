import { Client } from 'pg';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import { checkpointRow, routeRow, rowHash, runRow } from '../setup/patrol-rows';
import { placeRow } from '../setup/safety-rows';
import { gateRow, shiftRow } from '../setup/security-rows';
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
  let routeId: string;
  let versionId: string;
  let runId: string;
  let otherRunId: string;
  let shiftId: string;

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
        ({ routeId, versionId } = await routeRow(tx, {
          tenantId,
          gateId,
          createdById: managerId,
          checkpointIds: [checkpointId],
          schedule: { days: [1], times: ['08:00'] },
        }));
        const run = (inHours: number) =>
          runRow(tx, { tenantId, routeId, versionId, gateId, inHours });
        runId = await run(24);
        otherRunId = await run(48);
        shiftId = await shiftRow(tx, { tenantId, guardId: otherId, gateId });
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
    for (const table of [
      'patrol_checkpoints',
      'patrol_routes',
      'patrol_route_versions',
      'patrol_runs',
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
    for (const table of ['patrol_route_checkpoints'])
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
      'patrol_checkpoints',
      'patrol_routes',
      'patrol_route_versions',
      'patrol_route_checkpoints',
      'patrol_runs',
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

  describe('patrol_routes', () => {
    const where = () => `id = '${routeId}'`;
    const retire = () =>
      `UPDATE patrol_routes SET retired_at = now(), retired_by_account_id = '${managerId}' WHERE ${where()}`;

    it('its post never changes; renamed in service; retired once, then nothing changes', async () => {
      for (const set of [
        `gate_id = NULL, place_id = '${placeId}'`,
        `created_by_account_id = '${otherId}'`,
      ])
        await expect(
          asApp(`UPDATE patrol_routes SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/its post never changes/);
      await asApp(
        `UPDATE patrol_routes SET name_en = 'Renamed' WHERE ${where()}`,
        retire(),
      );
      for (const set of [
        'retired_at = NULL, retired_by_account_id = NULL',
        "name_ar = 'بعد'",
      ])
        await expect(
          asApp(retire(), `UPDATE patrol_routes SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/retired once/);
      await expect(
        asApp('UPDATE patrol_routes SET retired_at = now() WHERE ' + where()),
      ).rejects.toThrow(/patrol_routes_retired_shape/);
    });
  });

  describe('patrol_route_versions', () => {
    const where = () => `id = '${versionId}'`;

    it('what it says never changes; superseded once', async () => {
      for (const set of [
        'ordered = true',
        'expected_minutes = 60',
        'schedule = \'{"days": [2], "times": ["09:00"]}\'',
        'number = 2',
        `route_id = gen_random_uuid()`,
      ])
        await expect(
          asApp(`UPDATE patrol_route_versions SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/what a version says never changes/);
      const supersede = `UPDATE patrol_route_versions SET superseded_at = now() WHERE ${where()}`;
      await asApp(supersede);
      await expect(
        asApp(
          supersede,
          `UPDATE patrol_route_versions SET superseded_at = NULL WHERE ${where()}`,
        ),
      ).rejects.toThrow(/what a version says never changes/);
    });

    it('one current version per route; a range for its minutes; a schedule is an object of arrays', async () => {
      const another = (extra: string) =>
        `INSERT INTO patrol_route_versions (id, tenant_id, route_id, number, ordered, expected_minutes, schedule, created_by_account_id)
         VALUES (gen_random_uuid(), '${tenantId}', '${routeId}', 9, false, ${extra}, '${managerId}')`;
      await expect(asApp(another('30, NULL'))).rejects.toThrow(
        /patrol_route_versions_current_key/,
      );
      await expect(
        asApp(
          `UPDATE patrol_route_versions SET superseded_at = now() WHERE ${where()}`,
          another('4, NULL'),
        ),
      ).rejects.toThrow(/patrol_route_versions_expected_range/);
      await expect(
        asApp(
          `UPDATE patrol_route_versions SET superseded_at = now() WHERE ${where()}`,
          another(`30, '[1]'`),
        ),
      ).rejects.toThrow(/patrol_route_versions_schedule_shape/);
    });
  });

  it('a version’s stops never change, each checkpoint once, at a position of 1 to 50', async () => {
    // Through the owner: the app has no UPDATE grant to try with.
    await expect(
      attempt(
        migrator,
        `UPDATE patrol_route_checkpoints SET position = 2 WHERE version_id = '${versionId}'`,
      ),
    ).rejects.toThrow(/append-only/);
    const stop = (position: number) =>
      `INSERT INTO patrol_route_checkpoints (id, tenant_id, version_id, position, checkpoint_id)
       VALUES (gen_random_uuid(), '${tenantId}', '${versionId}', ${position}, '${checkpointId}')`;
    await expect(asApp(stop(2))).rejects.toThrow(
      /patrol_route_checkpoints_checkpoint_key/,
    );
    await expect(asApp(stop(51))).rejects.toThrow(
      /patrol_route_checkpoints_position_range/,
    );
  });

  describe('patrol_runs', () => {
    const where = (id = runId) => `id = '${id}'`;
    const start = (id = runId) =>
      `UPDATE patrol_runs SET status = 'in_progress', guard_account_id = '${otherId}', shift_id = '${shiftId}', started_at = now() WHERE ${where(id)}`;

    it('what a run is never changes', async () => {
      for (const set of [
        `route_id = gen_random_uuid()`,
        "kind = 'adhoc', scheduled_start = NULL, window_ends_at = NULL",
        "scheduled_start = scheduled_start + interval '1 hour', planned_at = planned_at + interval '1 hour'",
        'checkpoints_total = 2',
      ])
        await expect(
          asApp(`UPDATE patrol_runs SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/a run moves forward only/);
    });

    it('moves forward only: started once, ended once; its count only grows; late once', async () => {
      await asApp(
        `UPDATE patrol_runs SET late_at = now() WHERE ${where()}`,
        start(),
        `UPDATE patrol_runs SET scanned_count = 1 WHERE ${where()}`,
        `UPDATE patrol_runs SET status = 'completed', ended_at = now() WHERE ${where()}`,
      );
      for (const steps of [
        [
          `UPDATE patrol_runs SET status = 'completed', ended_at = now() WHERE ${where()}`,
        ],
        [
          start(),
          `UPDATE patrol_runs SET status = 'scheduled', guard_account_id = NULL, shift_id = NULL, started_at = NULL WHERE ${where()}`,
        ],
        [
          start(),
          `UPDATE patrol_runs SET guard_account_id = '${managerId}' WHERE ${where()}`,
        ],
        [
          start(),
          `UPDATE patrol_runs SET scanned_count = 1 WHERE ${where()}`,
          `UPDATE patrol_runs SET scanned_count = 0 WHERE ${where()}`,
        ],
        [
          `UPDATE patrol_runs SET late_at = now() WHERE ${where()}`,
          `UPDATE patrol_runs SET late_at = now() + interval '1 minute' WHERE ${where()}`,
        ],
        [
          `UPDATE patrol_runs SET status = 'missed', ended_at = now() WHERE ${where()}`,
          `UPDATE patrol_runs SET ended_at = now() + interval '1 minute' WHERE ${where()}`,
        ],
      ])
        await expect(asApp(...steps)).rejects.toThrow(
          /a run moves forward only|patrol_runs_completed_shape/,
        );
    });

    it('the shapes hold whatever the services do', async () => {
      for (const [steps, check] of [
        [
          [
            `UPDATE patrol_runs SET status = 'in_progress', started_at = now() WHERE ${where()}`,
          ],
          'patrol_runs_started_shape',
        ],
        [
          [`UPDATE patrol_runs SET status = 'missed' WHERE ${where()}`],
          'patrol_runs_ended_shape',
        ],
        [
          [
            start(),
            `UPDATE patrol_runs SET status = 'incomplete', ended_at = now() WHERE ${where()}`,
          ],
          'patrol_runs_end_reason',
        ],
        [
          [
            start(),
            `UPDATE patrol_runs SET status = 'incomplete', ended_at = now(), end_reason = 'tired' WHERE ${where()}`,
          ],
          'patrol_runs_end_reason',
        ],
        [
          [
            start(),
            `UPDATE patrol_runs SET status = 'completed', ended_at = now() WHERE ${where()}`,
          ],
          'patrol_runs_completed_shape',
        ],
        [
          [
            `UPDATE patrol_runs SET status = 'cancelled', ended_at = now(), cancel_reason = 'route_changed', cancelled_by_account_id = '${managerId}' WHERE ${where()}`,
          ],
          'patrol_runs_cancelled_by',
        ],
        [
          [
            `UPDATE patrol_runs SET status = 'cancelled', ended_at = now(), cancel_reason = 'not_needed' WHERE ${where()}`,
          ],
          'patrol_runs_cancelled_by',
        ],
        [
          [
            `UPDATE patrol_runs SET status = 'cancelled', ended_at = now(), cancel_reason = 'bored', cancelled_by_account_id = '${managerId}' WHERE ${where()}`,
          ],
          'patrol_runs_cancel_reason',
        ],
      ] as const)
        await expect(asApp(...steps)).rejects.toThrow(new RegExp(check));
      await expect(
        asApp(
          `INSERT INTO patrol_runs (id, tenant_id, route_id, version_id, gate_id, kind, planned_at, status, checkpoints_total, updated_at)
           VALUES (gen_random_uuid(), '${tenantId}', '${routeId}', '${versionId}', '${gateId}', 'adhoc', now(), 'scheduled', 1, now())`,
        ),
      ).rejects.toThrow(/patrol_runs_kind_shape|patrol_runs_planned/);
    });

    it('one run under way per guard; a version makes each scheduled run once', async () => {
      await expect(asApp(start(), start(otherRunId))).rejects.toThrow(
        /patrol_runs_one_live_per_guard/,
      );
      await expect(
        asApp(
          `INSERT INTO patrol_runs (id, tenant_id, route_id, version_id, gate_id, kind, planned_at, scheduled_start, window_ends_at, status, ended_at, cancel_reason, checkpoints_total, updated_at)
           SELECT gen_random_uuid(), tenant_id, route_id, version_id, gate_id, kind, planned_at, scheduled_start, window_ends_at, 'cancelled', now(), 'route_changed', 1, now()
             FROM patrol_runs WHERE ${where()}`,
        ),
      ).rejects.toThrow(/patrol_runs_scheduled_key/);
    });
  });
});
