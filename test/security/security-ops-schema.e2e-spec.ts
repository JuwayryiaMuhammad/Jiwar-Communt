import { Client } from 'pg';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { newId } from '../../src/core/common/uuid';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import { permitRow } from '../setup/permits-rows';
import {
  blocklistRow,
  incidentAckRow,
  incidentNoteRow,
  incidentPhotoRow,
  incidentRow,
  lockdownRow,
  matchRow,
  overrideRow,
  personRow,
  refusalRow,
  workStopRow,
} from '../setup/security-ops-rows';
import { dutyFileRow, gateRow, shiftRow } from '../setup/security-rows';
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
  let permitId: string;
  let stopId: string;
  let incidentId: string;
  let noteId: string;

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Security schema');
    guardId = (await createAccountRow(h, tenantId)).id;
    managerId = (await createAccountRow(h, tenantId)).id;
    const unitId = (await createUnit(h, tenantId)).id;
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
        await matchRow(tx, {
          tenantId,
          entryId: plateEntryId,
          actorId: guardId,
          gateId,
        });
        await refusalRow(tx, { tenantId });
        permitId = await permitRow(tx, {
          tenantId,
          unitId,
          requestedById: managerId,
        });
        stopId = await workStopRow(tx, {
          tenantId,
          permitId,
          stoppedById: guardId,
        });
        incidentId = await incidentRow(tx, {
          tenantId,
          unitId,
          reportedById: guardId,
        });
        noteId = await incidentNoteRow(tx, {
          tenantId,
          incidentId,
          authorId: managerId,
        });
        await incidentPhotoRow(tx, {
          tenantId,
          incidentId,
          fileId: await dutyFileRow(tx, tenantId, 'incident_photo'),
          uploadedById: guardId,
        });
        await incidentAckRow(tx, { tenantId, incidentId, accountId: guardId });
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
      'permit_work_stops',
      'incidents',
      'incident_notes',
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
    for (const table of [
      'gate_lockdown_overrides',
      'blocklist_matches',
      'security_refusals',
      'incident_photos',
      'incident_acknowledgements',
    ])
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
      'blocklist_matches',
      'security_refusals',
      'permit_work_stops',
      'incidents',
      'incident_photos',
      'incident_notes',
      'incident_acknowledgements',
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

  describe('permit_work_stops', () => {
    const where = () => `id = '${stopId}'`;

    it('one live stop per permit; ended once, with how; what stopped it never changes', async () => {
      await expect(
        asApp(
          `INSERT INTO permit_work_stops (id, tenant_id, permit_id, stopped_by_account_id, reason_code, stopped_at, updated_at)
           VALUES ('${newId()}', '${tenantId}', '${permitId}', '${guardId}', 'damage', now(), now())`,
        ),
      ).rejects.toThrow(/permit_work_stops_one_live/);
      for (const set of [
        `reason_code = 'damage'`,
        `stopped_at = now() - interval '1 hour'`,
      ])
        await expect(
          asApp(`UPDATE permit_work_stops SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/ended once/);
      await expect(
        asApp(
          `UPDATE permit_work_stops SET ended_at = now(), end_kind = 'resumed' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/permit_work_stops_end_shape/);
      const resume = `UPDATE permit_work_stops SET ended_at = now(), ended_by_account_id = '${managerId}', end_kind = 'resumed' WHERE ${where()}`;
      await expect(asApp(resume)).resolves.toMatchObject({ rowCount: 1 });
      await expect(asApp(resume, resume)).rejects.toThrow(/ended once/);
      await expect(
        asApp(
          `UPDATE permit_work_stops SET ended_at = now(), end_kind = 'permit_revoked' WHERE ${where()}`,
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    });

    it('only a works permit has its work stopped', async () => {
      const move = await h.asTenant(tenantId, () =>
        h.tenantTx.withTenantTx(async (tx) =>
          permitRow(tx, {
            tenantId,
            unitId: (
              await tx.unitPermit.findUniqueOrThrow({ where: { id: permitId } })
            ).unitId,
            requestedById: managerId,
            kind: 'move',
          }),
        ),
      );
      await expect(
        asApp(
          `INSERT INTO permit_work_stops (id, tenant_id, permit_id, permit_kind, stopped_by_account_id, reason_code, stopped_at, updated_at)
           VALUES ('${newId()}', '${tenantId}', '${move}', 'move', '${guardId}', 'damage', now(), now())`,
        ),
      ).rejects.toThrow(/permit_work_stops_kind/);
      await expect(
        asApp(
          `INSERT INTO permit_work_stops (id, tenant_id, permit_id, stopped_by_account_id, reason_code, stopped_at, updated_at)
           VALUES ('${newId()}', '${tenantId}', '${move}', '${guardId}', 'damage', now(), now())`,
        ),
      ).rejects.toThrow(/permit_work_stops_permit_fkey/);
    });
  });

  describe('incidents', () => {
    const where = () => `id = '${incidentId}'`;
    const assign = () =>
      `UPDATE incidents SET status = 'investigating', investigator_account_id = '${managerId}', assigned_at = now() WHERE `;
    const close = () =>
      `UPDATE incidents SET status = 'closed', outcome = 'resolved', closing_note = 'Done', closed_by_account_id = '${managerId}', closed_at = now() WHERE `;

    it('the report never changes; its words are cleared once at most', async () => {
      for (const set of [
        `type = 'fire'`,
        `severity = 'critical'`,
        `occurred_at = now() - interval '1 day'`,
        `reported_by_account_id = '${managerId}'`,
        `description = 'Other words'`,
      ])
        await expect(
          asApp(`UPDATE incidents SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/never changes/);
      const clear = `UPDATE incidents SET description = NULL, text_cleared_at = now() WHERE ${where()}`;
      await expect(asApp(clear)).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        asApp(`UPDATE incidents SET description = NULL WHERE ${where()}`),
      ).rejects.toThrow(/incidents_description/);
      // Once: a second clear at another moment, or the words written back,
      // is refused. The moment differs explicitly: two clock reads may not.
      for (const again of [
        `text_cleared_at = text_cleared_at + interval '1 second'`,
        `description = 'Back', text_cleared_at = NULL`,
      ])
        await expect(
          asApp(clear, `UPDATE incidents SET ${again} WHERE ${where()}`),
        ).rejects.toThrow(/never changes/);
    });

    it('forward only: open → investigating → closed; closed, nothing changes but the closer’s words, once', async () => {
      await expect(
        asApp(
          `${assign()}${where()}`,
          `UPDATE incidents SET status = 'open', investigator_account_id = NULL, assigned_at = NULL WHERE ${where()}`,
        ),
      ).rejects.toThrow(/never changes/);
      await expect(
        asApp(`${assign()}${where()}`, `${close()}${where()}`),
      ).resolves.toBeDefined();
      for (const set of [
        `outcome = 'other'`,
        `investigator_account_id = '${guardId}'`,
        `closed_at = now() + interval '1 hour'`,
      ])
        await expect(
          asApp(
            `${close()}${where()}`,
            `UPDATE incidents SET ${set} WHERE ${where()}`,
          ),
        ).rejects.toThrow(/never changes/);
      const clearNote = `UPDATE incidents SET closing_note = NULL, closing_note_cleared_at = now() WHERE ${where()}`;
      await expect(
        asApp(`${close()}${where()}`, clearNote),
      ).resolves.toMatchObject({ rowCount: 1 });
      for (const again of [
        `closing_note_cleared_at = closing_note_cleared_at + interval '1 second'`,
        `closing_note = 'Back', closing_note_cleared_at = NULL`,
      ])
        await expect(
          asApp(
            `${close()}${where()}`,
            clearNote,
            `UPDATE incidents SET ${again} WHERE ${where()}`,
          ),
        ).rejects.toThrow(/never changes/);
    });

    it('the shapes: somewhere, a status that agrees, a closing note on a close', async () => {
      await expect(
        asApp(
          `INSERT INTO incidents (id, tenant_id, number, type, severity, occurred_at, description, reported_by_account_id, updated_at)
           VALUES ('${newId()}', '${tenantId}', 777001, 'hazard', 'low', now(), 'Nowhere', '${guardId}', now())`,
        ),
      ).rejects.toThrow(/incidents_where/);
      await expect(
        asApp(`UPDATE incidents SET status = 'investigating' WHERE ${where()}`),
      ).rejects.toThrow(/incidents_state_shape/);
      await expect(
        asApp(
          `UPDATE incidents SET status = 'closed', outcome = 'resolved', closed_by_account_id = '${managerId}', closed_at = now() WHERE ${where()}`,
        ),
      ).rejects.toThrow(/incidents_closing_note/);
      await expect(
        asApp(
          `UPDATE incidents SET status = 'closed', outcome = 'shrug', closing_note = 'x', closed_by_account_id = '${managerId}', closed_at = now() WHERE ${where()}`,
        ),
      ).rejects.toThrow(/incidents_outcome/);
    });

    it('a note is kept, its words cleared once at most', async () => {
      const at = `id = '${noteId}'`;
      await expect(
        asApp(`UPDATE incident_notes SET body = 'Edited' WHERE ${at}`),
      ).rejects.toThrow(/cleared once/);
      const clear = `UPDATE incident_notes SET body = NULL, text_cleared_at = now() WHERE ${at}`;
      await expect(asApp(clear)).resolves.toMatchObject({ rowCount: 1 });
      for (const again of [
        `text_cleared_at = text_cleared_at + interval '1 second'`,
        `body = 'Back', text_cleared_at = NULL`,
      ])
        await expect(
          asApp(clear, `UPDATE incident_notes SET ${again} WHERE ${at}`),
        ).rejects.toThrow(/cleared once/);
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
