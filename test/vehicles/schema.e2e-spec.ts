import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLATE_FOLD_FROM,
  PLATE_FOLD_TO,
  plateKey,
} from '../../src/core/common/vehicle-plate';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import { required } from '../setup/test-env';
import {
  areaRow,
  expiryReminderRow,
  finePaymentRow,
  fineRow,
  parkingBookingRow,
  reportRow,
  stickerRow,
  vehicleRow,
} from '../setup/vehicles-rows';

/**
 * The vehicles and parking tables (ADR 0045) at the database: what the
 * app may write, what is append-only even for its owner, what the triggers
 * keep, the shapes the CHECKs hold whatever the services do, and the plate
 * key the database computes as the code does.
 */
describe('Vehicles tables — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let migrator: Client;
  let tenantId: string;
  let accountId: string;
  let otherId: string;
  let unitId: string;
  let vehicleId: string;
  let stickerId: string;
  let twinId: string;
  let twinStickerId: string;
  let reminderId: string;
  let areaId: string;
  let bookingId: string;
  let fineId: string;
  let paymentId: string;
  let reportId: string;

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Vehicles schema');
    accountId = (await createAccountRow(h, tenantId)).id;
    otherId = (await createAccountRow(h, tenantId)).id;
    unitId = (await createUnit(h, tenantId)).id;
    await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx: TenantTxClient) => {
        vehicleId = await vehicleRow(tx, {
          tenantId,
          unitId,
          registeredById: accountId,
          plate: 'KEY 77',
        });
        stickerId = await stickerRow(tx, {
          tenantId,
          vehicleId,
          issuedById: accountId,
        });
        // The same plate typed otherwise: one key.
        twinId = await vehicleRow(tx, {
          tenantId,
          unitId,
          registeredById: accountId,
          plate: 'KEY٧٧',
        });
        twinStickerId = await stickerRow(tx, {
          tenantId,
          vehicleId: twinId,
          issuedById: accountId,
        });
        reminderId = await expiryReminderRow(tx, { tenantId, vehicleId });
        areaId = await areaRow(tx, tenantId);
        bookingId = await parkingBookingRow(tx, {
          tenantId,
          unitId,
          areaId,
          bookedById: accountId,
        });
        fineId = await fineRow(tx, { tenantId, unitId, issuedById: accountId });
        paymentId = await finePaymentRow(tx, {
          tenantId,
          fineId,
          recordedById: accountId,
        });
        reportId = await reportRow(tx, { tenantId, reporterId: accountId });
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

  it('nothing of the domain is deleted by the app but a unit’s parking slot', async () => {
    const deletable: string[] = [];
    for (const table of [
      'vehicle_settings',
      'vehicle_counters',
      'vehicles',
      'vehicle_stickers',
      'vehicle_expiry_reminders',
      'unit_parking_slots',
      'visitor_parking_areas',
      'visitor_parking_bookings',
      'vehicle_fines',
      'vehicle_fine_payments',
      'parking_reports',
    ]) {
      const p = await privileges(table);
      expect({ table, select: p.select, truncate: p.truncate }).toEqual({
        table,
        select: true,
        truncate: false,
      });
      if (p.delete) deletable.push(table);
    }
    expect(deletable).toEqual(['unit_parking_slots']);
  });

  describe.each([
    ['vehicle_stickers', () => `id = '${stickerId}'`, `sticker_number = 'X-1'`],
    [
      'vehicle_expiry_reminders',
      () => `id = '${reminderId}'`,
      'created_at = now()',
    ],
    ['vehicle_fine_payments', () => `id = '${paymentId}'`, 'amount = 1'],
  ])('%s is append-only', (table, where, change) => {
    it('the app holds SELECT and INSERT, and nothing else', async () => {
      expect(await privileges(table)).toEqual({
        select: true,
        insert: true,
        update: false,
        delete: false,
        truncate: false,
      });
    });

    it('even its owner cannot update, delete or truncate it', async () => {
      for (const sql of [
        `UPDATE "${table}" SET ${change} WHERE ${where()}`,
        `DELETE FROM "${table}" WHERE ${where()}`,
      ])
        await expect(attempt(migrator, sql)).rejects.toThrow(/append-only/);
      // Stickers are referenced by the vehicles: refused before the trigger.
      await expect(attempt(migrator, `TRUNCATE "${table}"`)).rejects.toThrow(
        /append-only|referenced in a foreign key/,
      );
    });
  });

  describe('vehicles', () => {
    it('keeps its unit, number and registrant; a removal is final; then only the photo goes', async () => {
      await expect(
        asApp(
          `UPDATE vehicles SET number = number + 1 WHERE id = '${vehicleId}'`,
        ),
      ).rejects.toThrow(/keeps its unit/);
      await expect(
        asApp(
          `UPDATE vehicles SET status = 'removed', removed_at = now(), removal_side = 'system', removal_reason = 'registrant_left' WHERE id = '${vehicleId}'`,
          `UPDATE vehicles SET status = 'pending', removed_at = NULL, removal_side = NULL, removal_reason = NULL WHERE id = '${vehicleId}'`,
        ),
      ).rejects.toThrow(/removal is final/);
      await asApp(
        `UPDATE vehicles SET status = 'removed', removed_at = now(), removal_side = 'system', removal_reason = 'registrant_left' WHERE id = '${vehicleId}'`,
        `UPDATE vehicles SET licence_photo_file_id = NULL WHERE id = '${vehicleId}'`,
      );
      await expect(
        asApp(`DELETE FROM vehicles WHERE id = '${vehicleId}'`),
      ).rejects.toThrow(/permission denied|keeps its unit/);
    });

    const activate = (id: string, sticker: string) =>
      `UPDATE vehicles SET status = 'active', permit_valid_until = '2030-01-01',
         sticker_number = (SELECT sticker_number FROM vehicle_stickers WHERE id = '${sticker}')
       WHERE id = '${id}'`;

    it('active holds a sticker issued to it and a last day; the sticker must be its own', async () => {
      await expect(
        asApp(
          `UPDATE vehicles SET status = 'active', permit_valid_until = '2030-01-01' WHERE id = '${twinId}'`,
        ),
      ).rejects.toThrow(/vehicles_state_shape/);
      // Another vehicle's sticker is not this one's.
      await expect(asApp(activate(twinId, stickerId))).rejects.toThrow(
        /vehicles_sticker_issued_fkey/,
      );
      await asApp(activate(twinId, twinStickerId));
    });

    it('one active permit per plate key', async () => {
      await expect(
        asApp(activate(vehicleId, stickerId), activate(twinId, twinStickerId)),
      ).rejects.toThrow(/vehicles_one_active_plate/);
    });

    it('a sticker number is issued once in the compound', async () => {
      await expect(
        asApp(
          `INSERT INTO vehicle_stickers (id, tenant_id, vehicle_id, sticker_number, issued_by_account_id)
             SELECT gen_random_uuid(), tenant_id, '${twinId}', sticker_number, issued_by_account_id
               FROM vehicle_stickers WHERE id = '${stickerId}'`,
        ),
      ).rejects.toThrow(/vehicle_stickers_number_key/);
    });
  });

  describe('visitor parking bookings', () => {
    it('keep their window; are cancelled once; the name goes once', async () => {
      await expect(
        asApp(
          `UPDATE visitor_parking_bookings SET ends_at = ends_at + interval '1 minute' WHERE id = '${bookingId}'`,
        ),
      ).rejects.toThrow(/keeps its window/);
      await expect(
        asApp(
          `UPDATE visitor_parking_bookings SET status = 'cancelled', cancelled_at = now(), cancel_side = 'system', cancel_reason = 'booker_left' WHERE id = '${bookingId}'`,
          `UPDATE visitor_parking_bookings SET status = 'confirmed', cancelled_at = NULL, cancel_side = NULL, cancel_reason = NULL WHERE id = '${bookingId}'`,
        ),
      ).rejects.toThrow(/cancelled once/);
      await asApp(
        `UPDATE visitor_parking_bookings SET visitor_name = NULL, visitor_name_cleared_at = now() WHERE id = '${bookingId}'`,
      );
    });

    it('a pass or a name, never both; at most a day', async () => {
      await expect(
        asApp(
          `UPDATE visitor_parking_bookings SET visitor_name = NULL WHERE id = '${bookingId}'`,
        ),
      ).rejects.toThrow(/visitor_parking_bookings_visitor|keeps its window/);
      await expect(
        asApp(
          `INSERT INTO visitor_parking_bookings (id, tenant_id, number, unit_id, area_id, visitor_name, starts_at, ends_at, booked_by_account_id)
           VALUES (gen_random_uuid(), '${tenantId}', 1, '${unitId}', '${areaId}', 'Long', now(), now() + interval '25 hours', '${accountId}')`,
        ),
      ).rejects.toThrow(/visitor_parking_bookings_window/);
    });
  });

  describe('fines', () => {
    it('keep their terms; one appeal, cleared once; a decision and a cancellation are final', async () => {
      await expect(
        asApp(`UPDATE vehicle_fines SET amount = 1 WHERE id = '${fineId}'`),
      ).rejects.toThrow(/keeps its terms/);
      const appeal = `UPDATE vehicle_fines SET status = 'under_appeal', appeal_text = 'Words', appealed_by_account_id = '${accountId}', appealed_at = now() WHERE id = '${fineId}'`;
      await expect(
        asApp(
          appeal,
          `UPDATE vehicle_fines SET appeal_text = 'Other words' WHERE id = '${fineId}'`,
        ),
      ).rejects.toThrow(/keeps its terms/);
      await expect(
        asApp(
          appeal,
          `UPDATE vehicle_fines SET appealed_at = now() - interval '1 day' WHERE id = '${fineId}'`,
        ),
      ).rejects.toThrow(/keeps its terms/);
      await asApp(
        appeal,
        `UPDATE vehicle_fines SET appeal_text = NULL, appeal_cleared_at = now() WHERE id = '${fineId}'`,
      );
      await expect(
        asApp(
          appeal,
          `UPDATE vehicle_fines SET status = 'cancelled', appeal_decision = 'cancelled', decided_at = now(), decided_by_account_id = '${accountId}', cancel_reason = 'appeal_accepted', cancelled_at = now(), cancelled_by_account_id = '${accountId}' WHERE id = '${fineId}'`,
          `UPDATE vehicle_fines SET status = 'unpaid', cancel_reason = NULL, cancelled_at = NULL, cancelled_by_account_id = NULL WHERE id = '${fineId}'`,
        ),
      ).rejects.toThrow(/keeps its terms/);
    });

    describe('cancelled, by the board (no actor) or by the office (ADR 0055)', () => {
      const at = () => `id = '${fineId}'`;
      // Its first appeal upheld: each instant set explicitly, in order.
      const upheld = () => [
        `UPDATE vehicle_fines SET status = 'under_appeal', appeal_text = 'Words', appealed_by_account_id = '${accountId}', appealed_at = now() - interval '3 days' WHERE ${at()}`,
        `UPDATE vehicle_fines SET status = 'unpaid', appeal_decision = 'upheld', decided_at = now() - interval '2 days', decided_by_account_id = '${accountId}' WHERE ${at()}`,
      ];
      const byBoard = () => [
        ...upheld(),
        `UPDATE vehicle_fines SET board_appeal_at = now() - interval '1 day' WHERE ${at()}`,
        `UPDATE vehicle_fines SET status = 'cancelled', cancel_reason = 'board_overturned', cancelled_at = now() - interval '1 hour', cancelled_by_account_id = NULL, board_appeal_closed_at = now() - interval '1 hour' WHERE ${at()}`,
      ];
      const byOffice = () => [
        ...upheld(),
        `UPDATE vehicle_fines SET status = 'cancelled', cancel_reason = 'issued_in_error', cancelled_at = now() - interval '1 hour', cancelled_by_account_id = '${accountId}' WHERE ${at()}`,
      ];
      const clear = () =>
        `UPDATE vehicle_fines SET appeal_text = NULL, appeal_cleared_at = now() WHERE ${at()}`;

      it('still takes its later allowed change: the appeal’s words cleared, once', async () => {
        for (const cancelled of [byBoard(), byOffice()]) {
          await expect(asApp(...cancelled, clear())).resolves.toMatchObject({
            rowCount: 1,
          });
          await expect(
            asApp(
              ...cancelled,
              clear(),
              `UPDATE vehicle_fines SET appeal_cleared_at = appeal_cleared_at + interval '1 second' WHERE ${at()}`,
            ),
          ).rejects.toThrow(/keeps its terms/);
        }
      });

      it('keeps its terms and its cancellation, whether an actor or none cancelled it', async () => {
        const always = [
          `amount = 1`,
          `reason = 'other'`,
          `cancel_reason = 'duplicate'`,
          `cancelled_at = cancelled_at - interval '1 second'`,
          `status = 'unpaid', cancel_reason = NULL, cancelled_at = NULL, cancelled_by_account_id = NULL`,
        ];
        for (const set of [
          ...always,
          // The board's: no actor is ever written in afterwards.
          `cancelled_by_account_id = '${accountId}'`,
          `board_appeal_closed_at = board_appeal_closed_at + interval '1 second'`,
        ])
          await expect(
            asApp(
              ...byBoard(),
              `UPDATE vehicle_fines SET ${set} WHERE ${at()}`,
            ),
          ).rejects.toThrow(/keeps its terms/);
        for (const set of [
          ...always,
          // The office's: its actor is never removed nor replaced.
          `cancelled_by_account_id = NULL`,
          `cancelled_by_account_id = '${otherId}'`,
        ])
          await expect(
            asApp(
              ...byOffice(),
              `UPDATE vehicle_fines SET ${set} WHERE ${at()}`,
            ),
          ).rejects.toThrow(/keeps its terms/);
      });

      it('only the board’s reason goes without an actor', async () => {
        await expect(
          asApp(
            ...upheld(),
            `UPDATE vehicle_fines SET status = 'cancelled', cancel_reason = 'duplicate', cancelled_at = now() WHERE ${at()}`,
          ),
        ).rejects.toThrow(/vehicle_fines_state_shape/);
      });
    });

    it('under appeal exactly while appealed and undecided; an accepted appeal cancels', async () => {
      await expect(
        asApp(
          `UPDATE vehicle_fines SET status = 'under_appeal' WHERE id = '${fineId}'`,
        ),
      ).rejects.toThrow(/vehicle_fines_state_shape/);
      await expect(
        asApp(
          `UPDATE vehicle_fines SET status = 'under_appeal', appeal_text = 'W', appealed_by_account_id = '${accountId}', appealed_at = now() WHERE id = '${fineId}'`,
          `UPDATE vehicle_fines SET status = 'unpaid', appeal_decision = 'cancelled', decided_at = now(), decided_by_account_id = '${accountId}' WHERE id = '${fineId}'`,
        ),
      ).rejects.toThrow(/vehicle_fines_accepted_cancels/);
    });

    it('a payment names what was paid; a reversal names the payment, once', async () => {
      await expect(
        asApp(
          `INSERT INTO vehicle_fine_payments (id, tenant_id, fine_id, kind, recorded_by_account_id)
           VALUES (gen_random_uuid(), '${tenantId}', '${fineId}', 'payment', '${accountId}')`,
        ),
      ).rejects.toThrow(/vehicle_fine_payments_kind_shape/);
      const reversal = (reason: string) =>
        `INSERT INTO vehicle_fine_payments (id, tenant_id, fine_id, kind, reverses_id, reason_code, recorded_by_account_id)
         VALUES (gen_random_uuid(), '${tenantId}', '${fineId}', 'reversal', '${paymentId}', '${reason}', '${accountId}')`;
      await expect(
        asApp(reversal('refunded'), reversal('other')),
      ).rejects.toThrow(/vehicle_fine_payments_one_reversal/);
    });
  });

  describe('parking reports', () => {
    it('keep their words; the note goes once; handled once', async () => {
      await expect(
        asApp(
          `UPDATE parking_reports SET plate = 'OTHER' WHERE id = '${reportId}'`,
        ),
      ).rejects.toThrow(/keeps its words/);
      await asApp(
        `UPDATE parking_reports SET note = NULL, note_cleared_at = now() WHERE id = '${reportId}'`,
      );
      await expect(
        asApp(
          `UPDATE parking_reports SET status = 'closed', close_reason = 'duplicate', handled_at = now(), handled_by_account_id = '${accountId}' WHERE id = '${reportId}'`,
          `UPDATE parking_reports SET close_reason = 'resolved' WHERE id = '${reportId}'`,
        ),
      ).rejects.toThrow(/handled once/);
      await expect(
        asApp(
          `UPDATE parking_reports SET status = 'converted' WHERE id = '${reportId}'`,
        ),
      ).rejects.toThrow(/parking_reports_state_shape/);
    });
  });

  it('the database keys a plate as the code does', async () => {
    const plates = [
      'ق ب ط ١٢٣٤',
      'قبط1234',
      'ABC 123',
      'A B C 1 2 3',
      '٠١٢٣٤٥٦٧٨٩',
      'أ ب ٥',
      'ى ي ٩',
      // ADR 0047: each letter variant and the letter it is read as.
      'أ 1',
      'إ 1',
      'آ 1',
      'ا 1',
      'ى 2',
      'ي 2',
      'ة 3',
      'ه 3',
      'طة ى أ ١٢',
    ];
    const { rows } = await app.query<{ plate: string; key: string }>(
      `SELECT p AS plate, translate(replace(p, ' ', ''), $2, $3) AS key
         FROM unnest($1::text[]) AS p`,
      [plates, PLATE_FOLD_FROM, PLATE_FOLD_TO],
    );
    expect(rows.map((r) => r.key)).toEqual(plates.map((p) => plateKey(p)));
    expect(new Set(rows.slice(7, 11).map((r) => r.key)).size).toBe(1);
    expect(rows[11].key).toBe(rows[12].key);
    expect(rows[13].key).toBe(rows[14].key);
    expect(rows[15].key).toBe('طهيا12');
    // The generated columns compute it: one row per table, the stored key.
    const stored = await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx: TenantTxClient) => {
        const id = await vehicleRow(tx, {
          tenantId,
          unitId,
          registeredById: accountId,
          plate: 'أ ى ة ٤',
        });
        return (await tx.vehicle.findUniqueOrThrow({ where: { id } })).plateKey;
      }),
    );
    expect(stored).toBe(plateKey('ا ي ه 4'));
    // And the generated columns are that expression, on every table.
    const { rows: columns } = await migrator.query<{
      table: string;
      expr: string;
    }>(
      `SELECT c.table_name AS table, c.generation_expression AS expr
         FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.column_name = 'plate_key'
        ORDER BY c.table_name`,
    );
    expect(columns.map((c) => c.table)).toEqual([
      // A banned or watched plate (ADR 0053).
      'blocklist_entries',
      'parking_reports',
      // A move's truck and an event's guests (ADR 0049).
      'permit_guests',
      'unit_permits',
      'vehicle_fines',
      'vehicles',
      'visitor_details',
    ]);
    expect(
      new Set(
        columns.map((c) =>
          c.expr.replace(/"?(?:truck_|vehicle_)?plate"?/g, 'P'),
        ),
      ).size,
    ).toBe(1);
    for (const c of columns) {
      expect([c.table, c.expr.includes(PLATE_FOLD_FROM)]).toEqual([
        c.table,
        true,
      ]);
      expect([c.table, c.expr.includes(PLATE_FOLD_TO)]).toEqual([
        c.table,
        true,
      ]);
    }
  });

  describe('the fold migration’s pre-check (ADR 0047)', () => {
    // The migration's first block, run against a stand-in `vehicles` (a
    // temporary table comes first on the search path) so that two active
    // permits can differ only by a letter variant, as they could before.
    // The stand-in has no RLS, so every compound of the run counts its rows:
    // the number says nothing here, the refusal does.
    const precheck = () => {
      const sql = readFileSync(
        join(
          __dirname,
          '../../prisma/migrations/20261025090000_plate_key_fold/migration.sql',
        ),
        'utf8',
      );
      const start = sql.indexOf('DO $$');
      const end = sql.indexOf('END $$;', start) + 'END $$;'.length;
      return sql.slice(start, end);
    };
    async function run(plates: [string, string][]): Promise<void> {
      await migrator.query('BEGIN');
      try {
        await migrator.query(
          `CREATE TEMP TABLE vehicles (tenant_id uuid, plate text, status text)
             ON COMMIT DROP`,
        );
        for (const [plate, status] of plates)
          await migrator.query(
            'INSERT INTO pg_temp.vehicles VALUES ($1, $2, $3)',
            [tenantId, plate, status],
          );
        await migrator.query(precheck());
      } finally {
        await migrator.query('ROLLBACK');
      }
    }

    it('stops the deployment when two active permits fold to one plate', async () => {
      await expect(
        run([
          ['أ ب 12', 'active'],
          ['ا ب ١٢', 'active'],
        ]),
      ).rejects.toThrow(
        /plate_key_fold: \d+ plate\(s\) have two active permits/,
      );
      await expect(
        run([
          ['ى 5', 'active'],
          ['ي 5', 'active'],
          ['ة 6', 'active'],
          ['ه 6', 'active'],
        ]),
      ).rejects.toThrow(/plate_key_fold: \d+ plate/);
    });

    it('lets it through when they do not', async () => {
      await expect(
        run([
          ['أ ب 12', 'active'],
          ['ا ب 12', 'pending'],
          ['ا ب 13', 'active'],
        ]),
      ).resolves.toBeUndefined();
    });
  });
});
