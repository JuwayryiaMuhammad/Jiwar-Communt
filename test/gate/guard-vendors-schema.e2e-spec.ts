import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
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

  describe('a control room event', () => {
    const id = newId();
    const insert = () =>
      `INSERT INTO control_room_events (id, tenant_id, kind, severity, source_type, source_id, gate_id, shift_id)
       VALUES ('${id}', '${tenantId}', 'lockdown_started', 'high', 'lockdown', '${newId()}', '${gateId}', '${shiftId}')`;
    const set = (sql: string) =>
      `UPDATE control_room_events SET ${sql} WHERE id = '${id}'`;
    const ack = () =>
      set(`acknowledged_at = now(), acknowledged_by_account_id = '${guardId}'`);

    it('the app reads, writes, acknowledges and delivers it; never deletes', async () => {
      expect(await privileges('control_room_events')).toEqual(
        SELECT_INSERT_UPDATE,
      );
    });

    it('never changes what it says; acknowledged once; delivered or skipped once', async () => {
      await expect(
        asApp(
          insert(),
          ack(),
          set(`delivery = 'delivered', delivered_at = now()`),
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      for (const sql of [
        set(`kind = 'lockdown_ended'`),
        set(`severity = 'normal'`),
        set(`source_id = '${newId()}'`),
        set(`occurred_at = now() - interval '1 hour'`),
      ])
        await expect(asApp(insert(), sql)).rejects.toThrow(
          /acknowledged and delivered once/,
        );
      await expect(
        asApp(
          insert(),
          ack(),
          set(`acknowledged_at = now() + interval '1 minute'`),
        ),
      ).rejects.toThrow(/acknowledged and delivered once/);
      await expect(
        asApp(
          insert(),
          set(`delivery = 'skipped'`),
          set(`delivery = 'pending'`),
        ),
      ).rejects.toThrow(/acknowledged and delivered once/);
    });

    it('its shapes: an acknowledgement has its author; a delivery its instant', async () => {
      for (const [sql, check] of [
        [set(`acknowledged_at = now()`), 'shape'],
        [set(`delivery = 'delivered'`), 'shape'],
        [set(`delivery_attempts = -1`), 'shape'],
        [set(`last_error = 'vendor said no'`), 'error'],
      ])
        await expect(asApp(insert(), sql)).rejects.toThrow(
          new RegExp(`control_room_events_${check}`),
        );
      await expect(
        asApp(insert().replace(`'lockdown_started'`, `'coffee_break'`)),
      ).rejects.toThrow(/control_room_events_kind/);
    });
  });

  describe('guard-down alarms', () => {
    const deviceId = newId();
    const device = () =>
      `INSERT INTO guard_alarm_devices (id, tenant_id, device_ref, label, registered_by_account_id)
       VALUES ('${deviceId}', '${tenantId}', 'schema-${deviceId}', 'Vest', '${guardId}')`;
    const pairingId = newId();
    const pairing = () =>
      `INSERT INTO guard_alarm_pairings (id, tenant_id, device_id, guard_account_id, shift_id)
       VALUES ('${pairingId}', '${tenantId}', '${deviceId}', '${guardId}', '${shiftId}')`;
    const event = (outcome: string, extra = '') =>
      `INSERT INTO guard_alarm_events (id, tenant_id, device_ref, vendor_event_id, kind, occurred_at, outcome${extra ? ', pairing_id, guard_account_id' : ''})
       VALUES ('${newId()}', '${tenantId}', 'schema-${deviceId}', '${newId()}', 'panic', now(), '${outcome}'${extra})`;

    it('devices and pairings are written and moved; events only inserted', async () => {
      for (const table of ['guard_alarm_devices', 'guard_alarm_pairings'])
        expect({ table, ...(await privileges(table)) }).toEqual({
          table,
          ...SELECT_INSERT_UPDATE,
        });
      expect(await privileges('guard_alarm_events')).toEqual({
        select: true,
        insert: true,
        update: false,
        delete: false,
        truncate: false,
      });
    });

    it('a device keeps its reference and is retired once, with its reason and author', async () => {
      const retire = `UPDATE guard_alarm_devices SET retired_at = now(),
         retired_by_account_id = '${guardId}', retire_reason = 'lost' WHERE id = '${deviceId}'`;
      await expect(asApp(device(), retire)).resolves.toMatchObject({
        rowCount: 1,
      });
      for (const sql of [
        `UPDATE guard_alarm_devices SET device_ref = 'other' WHERE id = '${deviceId}'`,
      ])
        await expect(asApp(device(), sql)).rejects.toThrow(
          /keeps its reference and is retired once/,
        );
      await expect(
        asApp(
          device(),
          retire,
          `UPDATE guard_alarm_devices SET retire_reason = 'broken' WHERE id = '${deviceId}'`,
        ),
      ).rejects.toThrow(/keeps its reference and is retired once/);
      await expect(
        asApp(
          device(),
          `UPDATE guard_alarm_devices SET retired_at = now() WHERE id = '${deviceId}'`,
        ),
      ).rejects.toThrow(/guard_alarm_devices_retired/);
    });

    it('one open pairing a device; it ends once, with a reason from the list', async () => {
      await expect(
        asApp(
          device(),
          pairing(),
          `INSERT INTO guard_alarm_pairings (id, tenant_id, device_id, guard_account_id, shift_id)
           VALUES ('${newId()}', '${tenantId}', '${deviceId}', '${guardId}', '${shiftId}')`,
        ),
      ).rejects.toThrow(
        /guard_alarm_pairings_device_open|guard_alarm_pairings_guard_open/,
      );
      const end = (reason: string) =>
        `UPDATE guard_alarm_pairings SET ended_at = now(), end_reason = '${reason}' WHERE id = '${pairingId}'`;
      await expect(
        asApp(device(), pairing(), end('unpaired')),
      ).resolves.toMatchObject({
        rowCount: 1,
      });
      await expect(
        asApp(device(), pairing(), end('unpaired'), end('repaired')),
      ).rejects.toThrow(/ends once/);
      await expect(asApp(device(), pairing(), end('lost'))).rejects.toThrow(
        /guard_alarm_pairings_end/,
      );
    });

    it('an event says what came of it in the shape that fits, and never changes', async () => {
      await expect(asApp(device(), event('unpaired'))).resolves.toMatchObject({
        rowCount: 1,
      });
      // Raised: its pairing, guard and emergency.
      await expect(
        asApp(
          device(),
          pairing(),
          event('raised', `, '${pairingId}', '${guardId}'`),
        ),
      ).rejects.toThrow(/guard_alarm_events_outcome/);
      await expect(
        asApp(
          device(),
          pairing(),
          event('unpaired', `, '${pairingId}', '${guardId}'`),
        ),
      ).rejects.toThrow(/guard_alarm_events_outcome/);
      await expect(
        asApp(
          device(),
          event('unpaired'),
          `UPDATE guard_alarm_events SET outcome = 'raised'`,
        ),
      ).rejects.toThrow(/permission denied|immutable/);
    });
  });

  describe('a gate call', () => {
    let unitId: string;
    beforeAll(async () => {
      unitId = (await createUnit(h, tenantId)).id;
    });
    const id = newId();
    const insert = () =>
      `INSERT INTO gate_calls (id, tenant_id, unit_id, guard_account_id, shift_id, gate_id, reason_code)
       VALUES ('${id}', '${tenantId}', '${unitId}', '${guardId}', '${shiftId}', '${gateId}', 'other')`;
    const set = (sql: string) =>
      `UPDATE gate_calls SET ${sql} WHERE id = '${id}'`;
    const answer = () =>
      set(
        `status = 'answered', answered_at = now(), answered_by_account_id = '${guardId}'`,
      );
    const end = (status: string, reason: string) =>
      set(`status = '${status}', ended_at = now(), end_reason = '${reason}'`);

    it('the app writes and moves a call; a vendor event is only inserted', async () => {
      expect(await privileges('gate_calls')).toEqual(SELECT_INSERT_UPDATE);
      expect(await privileges('gate_call_vendor_events')).toEqual({
        select: true,
        insert: true,
        update: false,
        delete: false,
        truncate: false,
      });
    });

    it('moves forward and ends once: ringing → answered → ended, or missed, declined', async () => {
      await expect(
        asApp(insert(), answer(), end('ended', 'guard')),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        asApp(insert(), end('missed', 'missed')),
      ).resolves.toMatchObject({
        rowCount: 1,
      });
      for (const steps of [
        [
          answer(),
          set(
            `status = 'ringing', answered_at = NULL, answered_by_account_id = NULL`,
          ),
        ],
        [end('missed', 'missed'), answer()],
        [end('ended', 'guard'), set(`end_reason = 'resident'`)],
        [set(`unit_id = '${newId()}'`)],
        [set(`room_ref = 'r1'`), set(`room_ref = 'r2'`)],
      ])
        await expect(asApp(insert(), ...steps)).rejects.toThrow(
          /only moves forward and ends once/,
        );
    });

    it('its shapes and lists', async () => {
      for (const [sql, check] of [
        [set(`status = 'answered'`), 'shape'],
        [set(`status = 'ended'`), 'shape'],
        [set(`room_closed_at = now()`), 'shape'],
        [set(`room_ref = ''`), 'room_ref'],
        [end('ended', 'tired'), 'end_reason'],
      ])
        await expect(asApp(insert(), sql)).rejects.toThrow(
          new RegExp(`gate_calls_${check}`),
        );
      await expect(
        asApp(insert().replace(`'other')`, `'gossip')`)),
      ).rejects.toThrow(/gate_calls_reason/);
      await expect(
        asApp(
          insert(),
          `INSERT INTO gate_calls (id, tenant_id, unit_id, guard_account_id, shift_id, gate_id, reason_code)
           VALUES ('${newId()}', '${tenantId}', '${unitId}', '${guardId}', '${shiftId}', '${gateId}', 'other')`,
        ),
      ).rejects.toThrow(/gate_calls_guard_live|gate_calls_unit_live/);
    });
  });
});
