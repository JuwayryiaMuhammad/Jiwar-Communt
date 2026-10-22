import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import {
  partnerRow,
  partnerServiceRow,
  requestEventRow,
  requestItemRow,
  requestRow,
  subcategoryRow,
} from '../setup/partners-rows';
import { createUnit } from '../setup/fixtures';
import { required } from '../setup/test-env';

/**
 * The partners tables (ADR 0060) at the database: what the app may write,
 * which rows keep what they were made with even for their owner, and the
 * shapes the CHECKs hold whatever the services do.
 */
describe('Partners tables — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let migrator: Client;
  let tenantId: string;
  let accountId: string;
  let partnerId: string;
  let subcategoryId: string;
  let petsSubcategoryId: string;
  let requestId: string;
  let itemId: string;
  let eventId: string;

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Partners schema');
    accountId = (await createAccountRow(h, tenantId)).id;
    await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx: TenantTxClient) => {
        partnerId = await partnerRow(tx, { tenantId, createdById: accountId });
        subcategoryId = await subcategoryRow(tx, tenantId);
        petsSubcategoryId = await subcategoryRow(tx, tenantId, 'pets');
        await partnerServiceRow(tx, { tenantId, partnerId, subcategoryId });
      }),
    );
    const unitId = (await createUnit(h, tenantId)).id;
    await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx: TenantTxClient) => {
        requestId = await requestRow(tx, {
          tenantId,
          partnerId,
          unitId,
          requesterId: accountId,
        });
        itemId = await requestItemRow(tx, { tenantId, requestId });
        eventId = await requestEventRow(tx, {
          tenantId,
          requestId,
          actorAccountId: accountId,
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

  it('the app deletes only what is replaced as a whole or taken back; the rows it locks it may update', async () => {
    const deletable: string[] = [];
    const updatable: string[] = [];
    for (const table of [
      'partner_settings',
      'partner_subcategories',
      'partners',
      'partner_services',
      'partner_hours',
      'partner_price_items',
      'partner_favourites',
      'partner_request_counters',
      'partner_requests',
      'partner_request_items',
      'partner_request_events',
      'partner_desk_links',
    ]) {
      const p = await privileges(table);
      expect({ table, select: p.select, truncate: p.truncate }).toEqual({
        table,
        select: true,
        truncate: false,
      });
      if (p.delete) deletable.push(table);
      if (p.update) updatable.push(table);
    }
    expect(deletable).toEqual([
      'partner_services',
      'partner_hours',
      'partner_price_items',
      'partner_favourites',
    ]);
    expect(updatable).toEqual([
      'partner_settings',
      'partner_subcategories',
      'partners',
      'partner_request_counters',
      'partner_requests',
      'partner_desk_links',
    ]);
  });

  it('a partner keeps its listing and is never deleted, even by the tables’ owner', async () => {
    await expect(
      attempt(
        migrator,
        `UPDATE partners SET listed_at = now() - interval '1 day' WHERE id = '${partnerId}'`,
      ),
    ).rejects.toThrow(/keeps its listing/);
    await expect(
      attempt(migrator, `DELETE FROM partners WHERE id = '${partnerId}'`),
    ).rejects.toThrow(/keeps its listing/);
    await expect(
      attempt(migrator, `TRUNCATE partners CASCADE`),
    ).rejects.toThrow(/append-only|cannot truncate/);
    await asApp(`SELECT id FROM partners WHERE id = '${partnerId}' FOR UPDATE`);
  });

  it('a sub-category keeps its key and category', async () => {
    await expect(
      asApp(
        `UPDATE partner_subcategories SET key = 'renamed' WHERE id = '${subcategoryId}'`,
      ),
    ).rejects.toThrow(/keeps its key/);
    await expect(
      asApp(
        `UPDATE partner_subcategories SET category = 'pets' WHERE id = '${subcategoryId}'`,
      ),
    ).rejects.toThrow(/keeps its key/);
    await expect(
      asApp(
        `INSERT INTO partner_subcategories (id, tenant_id, category, key, name_en, name_ar)
         VALUES ('${newId()}', '${tenantId}', 'taxi', 'rides', 'Rides', 'رحلات')`,
      ),
    ).rejects.toThrow(/partner_subcategories_category/);
  });

  it('a suspended partner has its reason, time and who; an active one none; the reason is from the list', async () => {
    const set = (assignments: string) =>
      asApp(`UPDATE partners SET ${assignments} WHERE id = '${partnerId}'`);
    await expect(set(`status = 'suspended'`)).rejects.toThrow(
      /partners_status_shape/,
    );
    await expect(
      set(
        `status = 'suspended', suspended_reason = 'bad', suspended_at = now(), suspended_by_account_id = '${accountId}'`,
      ),
    ).rejects.toThrow(/partners_suspended_reason/);
    await set(
      `status = 'suspended', suspended_reason = 'safety', suspended_at = now(), suspended_by_account_id = '${accountId}'`,
    );
    await expect(set(`business_phone = '0100'`)).rejects.toThrow(
      /partners_business_phone_e164/,
    );
    await expect(set(`notify_email = 'nobody'`)).rejects.toThrow(
      /partners_notify_email_shape/,
    );
  });

  it('a service’s sub-category is one of its own category; each pair once, a whole category too', async () => {
    const service = (category: string, sub: string | null) =>
      `INSERT INTO partner_services (id, tenant_id, partner_id, category, subcategory_id)
       VALUES ('${newId()}', '${tenantId}', '${partnerId}', '${category}', ${sub ? `'${sub}'` : 'NULL'})`;
    await expect(
      asApp(service('home_services', petsSubcategoryId)),
    ).rejects.toThrow(/partner_services_subcategory_fkey/);
    await expect(
      asApp(service('home_services', subcategoryId)),
    ).rejects.toThrow(/partner_services_once_key/);
    await expect(
      asApp(service('pets', null), service('pets', null)),
    ).rejects.toThrow(/partner_services_once_key/);
  });

  it('a price is in EGP within its range, in a known unit', async () => {
    const price = (value: string, unit: string) =>
      `INSERT INTO partner_price_items (id, tenant_id, partner_id, name_en, name_ar, price, unit, position)
       VALUES ('${newId()}', '${tenantId}', '${partnerId}', 'x', 'x', ${value}, '${unit}', 0)`;
    await expect(asApp(price('-1', 'fixed'))).rejects.toThrow(
      /partner_price_items_price_range/,
    );
    await expect(asApp(price('10', 'per_day'))).rejects.toThrow(
      /partner_price_items_unit/,
    );
    await asApp(price('0', 'fixed'));
  });

  describe.each([
    ['partner_request_items', () => itemId, 'quantity = 2'],
    ['partner_request_events', () => eventId, "reason_code = 'x'"],
  ])('%s is append-only', (table, id, change) => {
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
        attempt(migrator, `UPDATE ${table} SET ${change} WHERE id = '${id()}'`),
      ).rejects.toThrow(/append-only/);
      await expect(
        attempt(migrator, `DELETE FROM ${table} WHERE id = '${id()}'`),
      ).rejects.toThrow(/append-only/);
      await expect(
        attempt(migrator, `TRUNCATE ${table} CASCADE`),
      ).rejects.toThrow(/append-only|cannot truncate/);
    });
  });

  describe('a request', () => {
    const set = (assignments: string) =>
      asApp(
        `UPDATE partner_requests SET ${assignments} WHERE id = '${requestId}'`,
      );

    it('keeps what it asked, and is never deleted', async () => {
      await expect(
        set(`asked_starts_at = asked_starts_at + interval '1 hour'`),
      ).rejects.toThrow(/keeps what it asked/);
      await expect(set(`gate_pass = false`)).rejects.toThrow(
        /keeps what it asked/,
      );
      await expect(set(`category = 'pets'`)).rejects.toThrow(
        /keeps what it asked/,
      );
      await expect(
        attempt(
          migrator,
          `DELETE FROM partner_requests WHERE id = '${requestId}'`,
        ),
      ).rejects.toThrow(/keeps what it asked/);
    });

    it('its note is cleared once, by an erasure, never rewritten', async () => {
      await expect(set(`note = 'Third floor'`)).rejects.toThrow(
        /keeps what it asked/,
      );
      await expect(set(`note = NULL`)).rejects.toThrow(/keeps what it asked/);
      await asApp(
        `UPDATE partner_requests SET note = NULL, note_cleared_at = now() WHERE id = '${requestId}'`,
      );
    });

    it('each status sets exactly its columns; who closes and why are the status’s', async () => {
      await expect(set(`status = 'accepted'`)).rejects.toThrow(
        /partner_requests_state_shape/,
      );
      await expect(
        set(
          `status = 'declined', closed_at = now(), closed_by = 'resident', close_reason = 'unavailable'`,
        ),
      ).rejects.toThrow(/partner_requests_closed_by/);
      await expect(
        set(
          `status = 'declined', closed_at = now(), closed_by = 'partner', close_reason = 'emergency'`,
        ),
      ).rejects.toThrow(/partner_requests_close_reason/);
      await expect(
        set(
          `status = 'proposed', proposed_starts_at = asked_starts_at, proposed_ends_at = asked_starts_at + interval '9 hours', staff_count = 1`,
        ),
      ).rejects.toThrow(/partner_requests_windows/);
      await expect(
        set(
          `status = 'proposed', proposed_starts_at = asked_starts_at, proposed_ends_at = asked_ends_at`,
        ),
      ).rejects.toThrow(/partner_requests_state_shape/);
    });

    it('accepted once, the agreement stays; closed once, it stays closed', async () => {
      await expect(
        asApp(
          `UPDATE partner_requests SET status = 'accepted', agreed_starts_at = asked_starts_at,
             agreed_ends_at = asked_ends_at, staff_count = 2, accepted_at = now()
           WHERE id = '${requestId}'`,
          `UPDATE partner_requests SET staff_count = 3 WHERE id = '${requestId}'`,
        ),
      ).rejects.toThrow(/keeps what it asked/);
      await expect(
        asApp(
          `UPDATE partner_requests SET status = 'expired', closed_at = now(), closed_by = 'system'
           WHERE id = '${requestId}'`,
          `UPDATE partner_requests SET status = 'pending', closed_at = NULL, closed_by = NULL
           WHERE id = '${requestId}'`,
        ),
      ).rejects.toThrow(/keeps what it asked/);
    });
  });

  describe('a desk link', () => {
    it('is revoked once and otherwise never changes; nothing deletes it', async () => {
      const id = newId();
      const insert = `INSERT INTO partner_desk_links (id, tenant_id, partner_id, token_hash, created_by_account_id, created_at, expires_at)
        VALUES ('${id}', '${tenantId}', '${partnerId}', '${'a'.repeat(64)}', '${accountId}', now(), now() + interval '90 days')`;
      await expect(
        asApp(
          insert,
          `UPDATE partner_desk_links SET expires_at = now() + interval '1 year' WHERE id = '${id}'`,
        ),
      ).rejects.toThrow(/revoked once/);
      await expect(
        asApp(
          insert,
          `UPDATE partner_desk_links SET revoked_at = now(), revoked_by_account_id = '${accountId}' WHERE id = '${id}'`,
          `UPDATE partner_desk_links SET revoked_at = now() + interval '1 hour' WHERE id = '${id}'`,
        ),
      ).rejects.toThrow(/revoked once/);
      await expect(
        attempt(
          migrator,
          insert,
          `DELETE FROM partner_desk_links WHERE id = '${id}'`,
        ),
      ).rejects.toThrow(/revoked once/);
      await expect(
        asApp(
          insert,
          `INSERT INTO partner_desk_links (id, tenant_id, partner_id, token_hash, created_by_account_id, created_at, expires_at)
           VALUES ('${newId()}', '${tenantId}', '${partnerId}', '${'b'.repeat(64)}', '${accountId}', now(), now() + interval '90 days')`,
        ),
      ).rejects.toThrow(/partner_desk_links_one_live/);
      await expect(
        asApp(
          `INSERT INTO partner_desk_links (id, tenant_id, partner_id, token_hash, created_by_account_id, created_at, expires_at)
           VALUES ('${newId()}', '${tenantId}', '${partnerId}', 'NOT-HEX', '${accountId}', now(), now() + interval '90 days')`,
        ),
      ).rejects.toThrow(/partner_desk_links_token_hash_hex/);
    });
  });
});
