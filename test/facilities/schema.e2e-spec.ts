import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  bookingRow,
  clubPlanRow,
  facilityRow,
  membershipRow,
  paymentRow,
  reminderRow,
} from '../setup/facilities-rows';
import { required } from '../setup/test-env';

/**
 * The facilities tables (ADR 0044) at the database: what the app may
 * write, which tables are append-only even for their owner, and the
 * shapes the CHECKs hold whatever the services do.
 */
describe('Facilities tables — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let migrator: Client;
  let tenantId: string;
  let accountId: string;
  let unitId: string;
  let facilityId: string;
  let bookingId: string;
  let membershipId: string;
  let paymentId: string;
  let reminderId: string;

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Facilities schema');
    accountId = (await createAccountRow(h, tenantId)).id;
    unitId = (await createUnit(h, tenantId)).id;
    await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx: TenantTxClient) => {
        facilityId = await facilityRow(tx, tenantId);
        bookingId = await bookingRow(tx, {
          tenantId,
          facilityId,
          unitId,
          bookedById: accountId,
        });
        const planId = await clubPlanRow(tx, tenantId);
        membershipId = await membershipRow(tx, {
          tenantId,
          unitId,
          createdById: accountId,
        });
        paymentId = await paymentRow(tx, {
          tenantId,
          membershipId,
          planId,
          recordedById: accountId,
        });
        reminderId = await reminderRow(tx, { tenantId, membershipId });
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

  it('nothing of the facilities domain is deleted by the app but a replaced set of weekly windows', async () => {
    const deletable: string[] = [];
    for (const table of [
      'facilities',
      'facility_hours',
      'facility_peak_windows',
      'facility_slot_locks',
      'facility_closures',
      'facility_settings',
      'bookings',
      'booking_suspensions',
      'club_plans',
      'club_memberships',
      'club_membership_people',
      'club_payment_records',
      'club_expiry_reminders',
    ]) {
      const p = await privileges(table);
      expect({ table, select: p.select, truncate: p.truncate }).toEqual({
        table,
        select: true,
        truncate: false,
      });
      if (p.delete) deletable.push(table);
    }
    expect(deletable).toEqual(['facility_hours', 'facility_peak_windows']);
  });

  describe.each([
    ['club_payment_records', () => `id = '${paymentId}'`, 'amount = 1'],
    [
      'club_expiry_reminders',
      () => `id = '${reminderId}'`,
      'created_at = now()',
    ],
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

    it('the tables’ owner cannot update, delete or truncate it either', async () => {
      await expect(
        attempt(migrator, `UPDATE ${table} SET ${change} WHERE ${where()}`),
      ).rejects.toThrow(/append-only/);
      await expect(
        attempt(migrator, `DELETE FROM ${table} WHERE ${where()}`),
      ).rejects.toThrow(/append-only/);
      await expect(
        attempt(migrator, `TRUNCATE ${table} CASCADE`),
      ).rejects.toThrow(/append-only|cannot truncate/);
    });
  });

  it('a membership never changes, though a payment locks its row', async () => {
    await expect(
      attempt(
        migrator,
        `UPDATE club_memberships SET created_at = now() WHERE id = '${membershipId}'`,
      ),
    ).rejects.toThrow(/append-only/);
    await asApp(
      `SELECT id FROM club_memberships WHERE id = '${membershipId}' FOR UPDATE`,
    );
  });

  it('a booking’s state sets exactly its columns; a reason is its side’s', async () => {
    const set = (assignments: string) =>
      asApp(`UPDATE bookings SET ${assignments} WHERE id = '${bookingId}'`);
    await expect(set(`status = 'cancelled'`)).rejects.toThrow(
      /bookings_state_shape/,
    );
    await expect(
      set(
        `status = 'cancelled', cancelled_at = now(), cancelled_side = 'resident', cancel_reason = 'facility_closed', cancelled_by_account_id = '${accountId}'`,
      ),
    ).rejects.toThrow(/bookings_cancel_reason/);
    await expect(
      set(
        `status = 'cancelled', cancelled_at = now(), cancelled_side = 'system', cancel_reason = 'facility_closed', cancelled_by_account_id = '${accountId}'`,
      ),
    ).rejects.toThrow(/bookings_cancelled_by/);
    await set(
      `status = 'cancelled', cancelled_at = now(), cancelled_side = 'system', cancel_reason = 'facility_closed'`,
    );
    await expect(
      set(
        `status = 'rejected', decided_at = now(), decided_by_account_id = '${accountId}'`,
      ),
    ).rejects.toThrow(/bookings_state_shape/);
    await expect(set(`guests = 1`)).rejects.toThrow(
      /bookings_party|keeps its slot/,
    );
  });

  it('a payment and a reversal each carry exactly their fields; the currency is EGP; a reversal is made once', async () => {
    await expect(
      asApp(
        `INSERT INTO club_payment_records (id, tenant_id, membership_id, kind, reverses_id, recorded_by_account_id)
         VALUES ('${newId()}', '${tenantId}', '${membershipId}', 'reversal', '${paymentId}', '${accountId}')`,
      ),
    ).rejects.toThrow(/club_payment_records_kind_shape/);
    await expect(
      asApp(
        `INSERT INTO club_payment_records (id, tenant_id, membership_id, kind, plan_id, amount, currency, receipt_number, paid_on, period_starts_on, period_ends_on, recorded_by_account_id)
         SELECT '${newId()}', tenant_id, membership_id, 'payment', plan_id, 10, 'USD', 'R-X', paid_on, period_starts_on, period_ends_on, recorded_by_account_id
           FROM club_payment_records WHERE id = '${paymentId}'`,
      ),
    ).rejects.toThrow(/club_payment_records_currency/);
    const reversal = (id: string) =>
      `INSERT INTO club_payment_records (id, tenant_id, membership_id, kind, reverses_id, reason_code, recorded_by_account_id)
       VALUES ('${id}', '${tenantId}', '${membershipId}', 'reversal', '${paymentId}', 'duplicate', '${accountId}')`;
    await expect(asApp(reversal(newId()), reversal(newId()))).rejects.toThrow(
      /club_payment_records_one_reversal/,
    );
    await expect(
      asApp(
        `INSERT INTO club_payment_records (id, tenant_id, membership_id, kind, reverses_id, reason_code, recorded_by_account_id)
         VALUES ('${newId()}', '${tenantId}', '${membershipId}', 'reversal', '${paymentId}', 'oops', '${accountId}')`,
      ),
    ).rejects.toThrow(/club_payment_records_reason/);
  });

  it('a covered person is exactly one of an occupancy or a household member', async () => {
    await expect(
      asApp(
        `INSERT INTO club_membership_people (id, tenant_id, membership_id, added_by_account_id)
         VALUES ('${newId()}', '${tenantId}', '${membershipId}', '${accountId}')`,
      ),
    ).rejects.toThrow(/club_membership_people_one_person/);
  });

  it('a walk-in facility has no rules; a bookable one has them all, the peak quota within the weekly one', async () => {
    const set = (assignments: string) =>
      asApp(`UPDATE facilities SET ${assignments} WHERE id = '${facilityId}'`);
    await expect(set('capacity = NULL')).rejects.toThrow(
      /facilities_rules_shape/,
    );
    await expect(set('peak_quota = 3, weekly_quota = 2')).rejects.toThrow(
      /facilities_peak_quota_within_weekly/,
    );
    await expect(set('slot_minutes = 10')).rejects.toThrow(
      /facilities_rules_ranges/,
    );
  });
});
