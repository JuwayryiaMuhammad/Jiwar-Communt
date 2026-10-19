import { Client } from 'pg';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  entryPhotoRow,
  evidenceRow,
  fieldExceptionRow,
  geofenceExitRow,
  incidentMediaRow,
  mediaFileRow,
  overstayAlertRow,
  patrolRunRow,
  rowAt,
  serviceVehicleRow,
  trackEvidenceRow,
  vehicleCountRow,
  visitorDetailsRow,
} from '../setup/gate-completion-rows';
import { incidentRow } from '../setup/security-ops-rows';
import { gateRow, shiftRow } from '../setup/security-rows';

/**
 * The tables of the gate's completion (ADR 0056) at the database: what the
 * app may write; what was asked never changes; an exception is decided
 * once and used once, within its window; an overstay alert is written once
 * and never changed; the shapes the CHECKs hold whatever the services do.
 * Every instant is written out.
 */
describe('The gate’s completion tables — CHECKs, triggers and privileges', () => {
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
  let alertId: string;
  let visitId: string;
  let photoEntryId: string;
  let keptEntryId: string;
  let incidentId: string;
  let runId: string;
  let exitId: string;
  let mediaId: string;
  let spareMediaId: string;

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
      alertId = await overstayAlertRow(tx, { tenantId, gateId, unitId });
      visitId = await serviceVehicleRow(tx, {
        tenantId,
        gateId,
        shiftId,
        guardId,
      });
      const photo = { tenantId, gateId, unitId, guardId };
      photoEntryId = await entryPhotoRow(tx, photo);
      keptEntryId = await entryPhotoRow(tx, photo);
      incidentId = await incidentRow(tx, {
        tenantId,
        unitId,
        reportedById: guardId,
      });
      await vehicleCountRow(tx, { tenantId, gateId });
      runId = await patrolRunRow(tx, {
        tenantId,
        gateId,
        createdById: managerId,
      });
      exitId = await geofenceExitRow(tx, { tenantId, runId, guardId });
      mediaId = (
        await tx.incidentMedia.findUniqueOrThrow({
          where: {
            id: await incidentMediaRow(tx, {
              tenantId,
              incidentId,
              byId: guardId,
            }),
          },
        })
      ).fileId;
      spareMediaId = await mediaFileRow(tx, tenantId);
      await trackEvidenceRow(tx, {
        tenantId,
        incidentId,
        runId,
        byId: managerId,
      });
      await evidenceRow(tx, {
        tenantId,
        incidentId,
        entryId: keptEntryId,
        byId: managerId,
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

  describe('an overstay alert', () => {
    it('is only ever added: never changed, deleted or truncated', async () => {
      expect(await privileges('visit_overstay_alerts')).toEqual({
        select: true,
        insert: true,
        update: false,
        delete: false,
        truncate: false,
      });
    });

    it('once per entry; visitors only; never before its visit was due', async () => {
      const insert = (entry: string, subject: string, alerted: number) =>
        asApp(
          `INSERT INTO visit_overstay_alerts (tenant_id, entry_id, subject_type, subject_id, gate_id,
              unit_id, entered_at, expected_minutes, alerted_at)
           VALUES ('${tenantId}', ${entry}, '${subject}', gen_random_uuid(), '${gateId}',
              '${unitId}', ${at(0)}, 15, ${at(alerted)})`,
        );
      await expect(
        insert('gen_random_uuid()', 'visitor_pass', 15),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(insert(`'${alertId}'`, 'visitor_pass', 20)).rejects.toThrow(
        /visit_overstay_alerts_pkey/,
      );
      await expect(
        insert('gen_random_uuid()', 'worker_engagement', 20),
      ).rejects.toThrow(/visit_overstay_alerts_subject/);
      await expect(
        insert('gen_random_uuid()', 'visitor_pass', 14),
      ).rejects.toThrow(/visit_overstay_alerts_after_due/);
    });
  });

  describe('a service vehicle’s visit', () => {
    const at2 = (minutes: number) => `'${rowAt(minutes).toISOString()}'`;
    const visit = () => `id = '${visitId}'`;
    const out = (minutes: number, by = `'${guardId}'`) =>
      `UPDATE service_vehicle_visits SET exited_at = ${at2(minutes)}, exited_gate_id = '${gateId}',
         exited_shift_id = ${by === 'NULL' ? 'NULL' : `'${shiftId}'`}, exited_by_account_id = ${by}
       WHERE ${visit()}`;

    it('the app reads, adds and closes them; it never deletes or truncates', async () => {
      expect(await privileges('service_vehicle_visits')).toEqual({
        select: true,
        insert: true,
        update: true,
        delete: false,
        truncate: false,
      });
    });

    it('its entry never changes; its exit is written once', async () => {
      for (const set of [
        `plate = 'OTHER 1'`,
        `kind = 'waste'`,
        `company = 'Other'`,
        `entered_at = ${at2(1)}`,
        `entered_by_account_id = '${otherId}'`,
      ])
        await expect(
          asApp(`UPDATE service_vehicle_visits SET ${set} WHERE ${visit()}`),
        ).rejects.toThrow(/an entry never changes/);
      await expect(asApp(out(30))).resolves.toMatchObject({ rowCount: 1 });
      for (const set of [
        `exited_at = ${at2(31)}`,
        `exited_by_account_id = '${otherId}'`,
        `exited_at = NULL, exited_gate_id = NULL, exited_shift_id = NULL, exited_by_account_id = NULL`,
      ])
        await expect(
          asApp(
            out(30),
            `UPDATE service_vehicle_visits SET ${set} WHERE ${visit()}`,
          ),
        ).rejects.toThrow(/its exit is written once/);
    });

    it('the shapes of an exit: by a guard, or the system’s unconfirmed one; never before the entry', async () => {
      await expect(
        asApp(
          `UPDATE service_vehicle_visits SET exited_at = ${at2(30)} WHERE ${visit()}`,
        ),
      ).rejects.toThrow(/service_vehicle_visits_exit_shape/);
      await expect(asApp(out(30, 'NULL'))).rejects.toThrow(
        /service_vehicle_visits_exit_shape/,
      );
      await expect(
        asApp(
          `UPDATE service_vehicle_visits SET exited_at = ${at2(30)}, exited_gate_id = '${gateId}',
             exit_unconfirmed = true WHERE ${visit()}`,
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(asApp(out(-1))).rejects.toThrow(
        /service_vehicle_visits_exit_shape/,
      );
    });

    it('a plate is inside once at a time, however typed; a unit or a facility, never both', async () => {
      const insert = (plate: string, served = 'NULL, NULL') =>
        asApp(
          `INSERT INTO service_vehicle_visits (id, tenant_id, plate, kind, company, unit_id, facility_id,
              entered_at, entered_gate_id, entered_shift_id, entered_by_account_id)
           VALUES (gen_random_uuid(), '${tenantId}', '${plate}', 'tanker', 'Co', ${served},
              ${at2(0)}, '${gateId}', '${shiftId}', '${guardId}')`,
        );
      await expect(insert('ش ط ١٢')).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        asApp(
          `INSERT INTO service_vehicle_visits (id, tenant_id, plate, kind, company, entered_at,
              entered_gate_id, entered_shift_id, entered_by_account_id)
           VALUES (gen_random_uuid(), '${tenantId}', 'ش ط ١٢', 'tanker', 'Co', ${at2(0)},
              '${gateId}', '${shiftId}', '${guardId}'),
                  (gen_random_uuid(), '${tenantId}', 'شط 12', 'waste', 'Co', ${at2(0)},
              '${gateId}', '${shiftId}', '${guardId}')`,
        ),
      ).rejects.toThrow(/service_vehicle_visits_one_inside/);
      await expect(
        insert('ش ط ١٣', `'${unitId}', gen_random_uuid()`),
      ).rejects.toThrow(/service_vehicle_visits_served|foreign key/);
      await expect(insert('ش ط ١٤')).resolves.toMatchObject({ rowCount: 1 });
    });
  });

  describe('a visitor’s photo, and an incident’s evidence', () => {
    it('a photo is added and purged, never changed; evidence is only ever added', async () => {
      // UPDATE for the row locks only (the link FOR SHARE, the purge FOR
      // UPDATE SKIP LOCKED); the trigger refuses the change itself.
      expect(await privileges('gate_entry_photos')).toEqual({
        select: true,
        insert: true,
        update: true,
        delete: true,
        truncate: false,
      });
      expect(await privileges('incident_evidence')).toEqual({
        select: true,
        insert: true,
        update: false,
        delete: false,
        truncate: false,
      });
    });

    it('kept 30 days by the hour; a visitor’s only; one row per file', async () => {
      const again = (subject: string, hours: number) =>
        asApp(
          `DELETE FROM gate_entry_photos WHERE entry_id = '${photoEntryId}'`,
          `INSERT INTO gate_entry_photos (tenant_id, entry_id, file_id, subject_type, subject_id, gate_id,
              unit_id, taken_by_account_id, entered_at, purge_after)
           SELECT tenant_id, gen_random_uuid(), id, '${subject}', gen_random_uuid(), '${gateId}',
              '${unitId}', '${guardId}', ${at(0)}, ${at(0)}::timestamptz + interval '${hours} hours'
             FROM files f
            WHERE purpose = 'visitor_photo'
              AND NOT EXISTS (SELECT 1 FROM gate_entry_photos p WHERE p.file_id = f.id)
            LIMIT 1`,
        );
      await expect(again('visitor_pass', 720)).resolves.toMatchObject({
        rowCount: 1,
      });
      await expect(again('worker_engagement', 720)).rejects.toThrow(
        /gate_entry_photos_subject/,
      );
      await expect(again('visitor_pass', 719)).rejects.toThrow(
        /gate_entry_photos_purge_after/,
      );
      await expect(
        asApp(
          `INSERT INTO gate_entry_photos (tenant_id, entry_id, file_id, subject_type, subject_id, gate_id,
              unit_id, taken_by_account_id, entered_at, purge_after)
           SELECT tenant_id, gen_random_uuid(), file_id, subject_type, subject_id, gate_id, unit_id,
              taken_by_account_id, entered_at, purge_after
             FROM gate_entry_photos WHERE entry_id = '${photoEntryId}'`,
        ),
      ).rejects.toThrow(/gate_entry_photos_file_key/);
      await expect(
        asApp(
          `UPDATE gate_entry_photos SET purge_after = purge_after + interval '1 hour'
            WHERE entry_id = '${photoEntryId}'`,
        ),
      ).rejects.toThrow(/gate_entry_photos is append-only \(UPDATE\)/);
    });

    it('a photo an incident keeps cannot be deleted; its evidence never changes', async () => {
      await expect(
        asApp(
          `DELETE FROM gate_entry_photos WHERE entry_id = '${photoEntryId}'`,
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        asApp(
          `DELETE FROM gate_entry_photos WHERE entry_id = '${keptEntryId}'`,
        ),
      ).rejects.toThrow(/incident_evidence_entry_photo_fkey/);
      await expect(
        asApp(
          `UPDATE incident_evidence SET linked_at = ${at(61)} WHERE incident_id = '${incidentId}'`,
        ),
      ).rejects.toThrow(/permission denied/);
      const add = (entry: string) =>
        asApp(
          `INSERT INTO incident_evidence (id, tenant_id, incident_id, kind, entry_id, linked_by_account_id, linked_at)
           VALUES (gen_random_uuid(), '${tenantId}', '${incidentId}', 'visitor_photo', ${entry},
              '${managerId}', ${at(62)})`,
        );
      await expect(add(`'${keptEntryId}'`)).rejects.toThrow(
        /incident_evidence_entry_key/,
      );
      await expect(add('NULL')).rejects.toThrow(/incident_evidence_shape/);
    });

    it('a run’s track is kept once per incident, by its run and nothing else', async () => {
      const add = (kind: string, entry: string, run: string) =>
        asApp(
          `INSERT INTO incident_evidence (id, tenant_id, incident_id, kind, entry_id, run_id, linked_by_account_id, linked_at)
           VALUES (gen_random_uuid(), '${tenantId}', '${incidentId}', '${kind}', ${entry}, ${run},
              '${managerId}', ${at(63)})`,
        );
      await expect(add('patrol_track', 'NULL', `'${runId}'`)).rejects.toThrow(
        /incident_evidence_run_key/,
      );
      await expect(add('patrol_track', 'NULL', 'NULL')).rejects.toThrow(
        /incident_evidence_shape/,
      );
      await expect(
        add('patrol_track', `'${photoEntryId}'`, `'${runId}'`),
      ).rejects.toThrow(/incident_evidence_shape/);
      await expect(
        add('visitor_photo', `'${photoEntryId}'`, `'${runId}'`),
      ).rejects.toThrow(/incident_evidence_shape/);
      await expect(add('selfie', 'NULL', 'NULL')).rejects.toThrow(
        /incident_evidence_kind/,
      );
    });
  });

  describe('a recording', () => {
    it('its rows are only ever added; its file is attached once', async () => {
      for (const table of ['patrol_note_media', 'incident_media'])
        expect({ table, ...(await privileges(table)) }).toEqual({
          table,
          select: true,
          insert: true,
          update: false,
          delete: false,
          truncate: false,
        });
      const add = (fileId: string, kind = 'audio', ms = 1000) =>
        `INSERT INTO incident_media (id, tenant_id, incident_id, file_id, kind, duration_ms, uploaded_by_account_id)
         VALUES (gen_random_uuid(), '${tenantId}', '${incidentId}', '${fileId}', '${kind}', ${ms}, '${guardId}')`;
      await expect(asApp(add(mediaId))).rejects.toThrow(
        /incident_media_file_key/,
      );
      await expect(asApp(add(spareMediaId, 'photo'))).rejects.toThrow(
        /incident_media_kind/,
      );
      await expect(asApp(add(spareMediaId, 'audio', 0))).rejects.toThrow(
        /incident_media_duration/,
      );
    });

    it('a recording’s file has its length once finalized; no other file has one', async () => {
      const file = (
        purpose: string,
        type: string,
        status: string,
        ms: string,
      ) =>
        asApp(
          `INSERT INTO files (id, tenant_id, owner_account_id, purpose, content_type, size_bytes, status, upload_expires_at, finalized_at, media_duration_ms)
           VALUES (gen_random_uuid(), '${tenantId}', '${guardId}', '${purpose}', '${type}', 100, '${status}', now(), ${status === 'ready' ? 'now()' : 'NULL'}, ${ms})`,
        );
      await expect(
        file('incident_audio', 'audio/mp4', 'pending', 'NULL'),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        file('incident_audio', 'audio/mp4', 'ready', '4200'),
      ).resolves.toMatchObject({ rowCount: 1 });
      for (const [purpose, type, status, ms] of [
        ['incident_audio', 'audio/mp4', 'ready', 'NULL'],
        ['incident_video', 'video/mp4', 'ready', '0'],
        ['incident_photo', 'image/png', 'ready', '1000'],
      ])
        await expect(file(purpose, type, status, ms)).rejects.toThrow(
          /files_media_duration/,
        );
    });
  });

  describe('a geofence exit', () => {
    const exit = () => `id = '${exitId}'`;

    it('the app reads, adds, closes and flags them; it never deletes or truncates', async () => {
      expect({
        table: 'patrol_geofence_exits',
        ...(await privileges('patrol_geofence_exits')),
      }).toEqual({
        table: 'patrol_geofence_exits',
        select: true,
        insert: true,
        update: true,
        delete: false,
        truncate: false,
      });
      await expect(
        asApp(`DELETE FROM patrol_geofence_exits WHERE ${exit()}`),
      ).rejects.toThrow(/permission denied/);
    });

    it('its run, guard and start never change; closed once, flagged once', async () => {
      for (const set of [
        `left_at = ${at(-1)}`,
        `guard_account_id = '${otherId}'`,
        `run_id = gen_random_uuid()`,
      ])
        await expect(
          asApp(`UPDATE patrol_geofence_exits SET ${set} WHERE ${exit()}`),
        ).rejects.toThrow(/closed once, flagged once/);
      const close = `UPDATE patrol_geofence_exits SET back_at = ${at(4)} WHERE ${exit()}`;
      await asApp(close);
      for (const again of [`back_at = ${at(5)}`, 'back_at = NULL'])
        await expect(
          asApp(
            close,
            `UPDATE patrol_geofence_exits SET ${again} WHERE ${exit()}`,
          ),
        ).rejects.toThrow(/closed once, flagged once/);
      const flag = `UPDATE patrol_geofence_exits SET flagged_at = ${at(3)}, flagged_minutes = 3 WHERE ${exit()}`;
      await asApp(flag);
      for (const again of [
        `flagged_at = ${at(6)}`,
        'flagged_minutes = 5',
        'flagged_at = NULL, flagged_minutes = NULL',
      ])
        await expect(
          asApp(
            flag,
            `UPDATE patrol_geofence_exits SET ${again} WHERE ${exit()}`,
          ),
        ).rejects.toThrow(/closed once, flagged once/);
    });

    it('back after it left; flagged with its minutes, 1 to 60', async () => {
      for (const [set, check] of [
        [`back_at = ${at(0)}`, 'back_after_left'],
        [`flagged_at = ${at(3)}`, 'flag_shape'],
        ['flagged_minutes = 3', 'flag_shape'],
        [`flagged_at = ${at(3)}, flagged_minutes = 61`, 'flagged_minutes'],
      ])
        await expect(
          asApp(`UPDATE patrol_geofence_exits SET ${set} WHERE ${exit()}`),
        ).rejects.toThrow(new RegExp(`patrol_geofence_exits_${check}`));
    });

    it('one per (run, start); one open per run', async () => {
      const another = (leftAt: string, backAt: string) =>
        `INSERT INTO patrol_geofence_exits (id, tenant_id, run_id, guard_account_id, left_at, back_at)
         VALUES (gen_random_uuid(), '${tenantId}', '${runId}', '${guardId}', ${leftAt}, ${backAt})`;
      await expect(asApp(another(at(0), at(9)))).rejects.toThrow(
        /patrol_geofence_exits_once_key/,
      );
      await expect(asApp(another(at(10), 'NULL'))).rejects.toThrow(
        /patrol_geofence_exits_open_key/,
      );
      await expect(
        asApp(
          `UPDATE patrol_geofence_exits SET back_at = ${at(4)} WHERE ${exit()}`,
          another(at(10), 'NULL'),
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    });
  });

  describe('a resident vehicles’ count', () => {
    // Read when a test runs: the ids are set in beforeAll.
    const counted = () =>
      `tenant_id = '${tenantId}' AND gate_id = '${gateId}' AND direction = 'in'`;

    it('the app adds and grows it, never deletes it', async () => {
      expect(await privileges('gate_vehicle_counts')).toEqual({
        select: true,
        insert: true,
        update: true,
        delete: false,
        truncate: false,
      });
    });

    it('only grows, by one; its day, gate and direction never change', async () => {
      await expect(
        asApp(
          `UPDATE gate_vehicle_counts SET count = count + 1 WHERE ${counted()}`,
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      for (const set of [
        'count = count + 2',
        'count = count - 1',
        `day = day + 1`,
        `direction = 'out'`,
      ])
        await expect(
          asApp(`UPDATE gate_vehicle_counts SET ${set} WHERE ${counted()}`),
        ).rejects.toThrow(/a count only grows, by one/);
      await expect(
        asApp(
          `INSERT INTO gate_vehicle_counts (tenant_id, day, gate_id, direction, count)
           VALUES ('${tenantId}', '2026-11-05', '${gateId}', 'in', 0)`,
        ),
      ).rejects.toThrow(/gate_vehicle_counts_positive/);
    });
  });

  it('the settings stay within their bounds', async () => {
    for (const set of [
      'exception_answer_minutes = 0',
      'exception_answer_minutes = 61',
      'exception_entry_minutes = 4',
      'exception_entry_minutes = 121',
      'visit_expected_minutes = 14',
      'visit_expected_minutes = 721',
      'geofence_exit_minutes = 0',
      'geofence_exit_minutes = 61',
      'audio_max_seconds = 9',
      'audio_max_seconds = 601',
      'video_max_seconds = 9',
      'video_max_seconds = 301',
      'audio_max_mb = 0',
      'audio_max_mb = 21',
      'video_max_mb = 0',
      'video_max_mb = 101',
    ])
      await expect(
        asApp(
          `UPDATE gate_settings SET ${set} WHERE tenant_id = '${tenantId}'`,
        ),
      ).rejects.toThrow(/gate_settings_(exception|visit|geofence|audio|video)/);
    // The overstay alert may be off.
    await expect(
      asApp(
        `UPDATE gate_settings SET visit_expected_minutes = NULL WHERE tenant_id = '${tenantId}'`,
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      asApp(`DELETE FROM gate_settings WHERE tenant_id = '${tenantId}'`),
    ).rejects.toThrow(/permission denied/);
  });
});
