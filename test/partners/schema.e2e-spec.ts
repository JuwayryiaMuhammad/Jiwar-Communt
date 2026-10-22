import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import {
  partnerRow,
  partnerServiceRow,
  subcategoryRow,
} from '../setup/partners-rows';
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
});
