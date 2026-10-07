import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { required } from '../setup/test-env';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Service = {
  id: string;
  key: string;
  nameEn: string;
  categoryId?: string;
  position?: number;
  active?: boolean;
};

const DEFAULTS = [
  'ac_service',
  'water_heater',
  'plumbing_check',
  'electrical_check',
];

/**
 * ADR 0038: the compound's preventive services. Seeded with four, managed
 * like the ticket categories, and offered to the residents while both the
 * service and its category are active.
 */
describe('Maintenance — preventive services', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(0);
  }, 90_000);

  afterAll(() => h.close());

  const manage = (method: 'get' | 'post' | 'patch', path = '', body?: object) =>
    d.http(
      method,
      `/maintenance/preventive-services${path}`,
      s.manager.token,
      body,
    );

  const offered = async (at: SetUp = s) =>
    (
      (await d.http('get', '/preventive-services', at.owner.token).expect(200))
        .body as { data: Service[] }
    ).data;

  const managed = async () =>
    ((await manage('get').expect(200)).body as { data: Service[] }).data;

  const audits = (action: string, targetId: string) =>
    d.inTenant(s.c, (tx) =>
      tx.auditLog.findMany({ where: { action, targetId } }),
    );

  it('a new compound has the four of the design, in its order, each under its category', async () => {
    expect((await offered()).map((x) => x.key)).toEqual(DEFAULTS);
    // The residents' view has no category, position or switch.
    expect(Object.keys((await offered())[0]).sort()).toEqual([
      'id',
      'key',
      'nameAr',
      'nameEn',
    ]);
    const byKey = new Map((await managed()).map((x) => [x.key, x]));
    expect(byKey.get('water_heater')).toMatchObject({
      categoryId: await d.categoryId(s.c, 'plumbing'),
      position: 2,
      active: true,
    });
    expect(byKey.get('ac_service')!.categoryId).toBe(
      await d.categoryId(s.c, 'ac'),
    );
  });

  it('the manager adds one (after the others), renames, reorders and retires it; keys and codes only in the audit trail', async () => {
    const created = await manage('post', '', {
      key: 'gas_check',
      nameAr: 'فحص الغاز',
      nameEn: 'Gas check',
      categoryId: await d.categoryId(s.c, 'general'),
    }).expect(201);
    const service = created.body as Service;
    expect(service).toMatchObject({ position: 5, active: true });
    expect((await offered()).map((x) => x.key)).toEqual([
      ...DEFAULTS,
      'gas_check',
    ]);
    expect(
      await audits('preventive_service.created', service.id),
    ).toMatchObject([
      {
        changes: {
          key: { from: null, to: 'gas_check' },
          categoryKey: { from: null, to: 'general' },
        },
      },
    ]);

    // First in the list now, under another category.
    await manage('patch', `/${service.id}`, {
      nameEn: 'Gas safety check',
      position: 0,
      categoryId: await d.categoryId(s.c, 'plumbing'),
    }).expect(200);
    expect((await offered())[0]).toMatchObject({
      key: 'gas_check',
      nameEn: 'Gas safety check',
    });
    expect(
      (await audits('preventive_service.updated', service.id))[0].changes,
    ).toMatchObject({
      position: { from: 5, to: 0 },
      categoryKey: { from: 'general', to: 'plumbing' },
    });

    // Retired: kept, no longer offered. The key never changes.
    const retired = await manage('patch', `/${service.id}`, {
      active: false,
      key: 'renamed',
    });
    expect(retired.status).toBe(400);
    await manage('patch', `/${service.id}`, { active: false }).expect(200);
    expect((await offered()).map((x) => x.key)).toEqual(DEFAULTS);
    expect((await managed()).find((x) => x.id === service.id)).toMatchObject({
      key: 'gas_check',
      active: false,
    });
  });

  it('a key is taken once per compound, and the category must be an active one of it', async () => {
    const body = {
      key: 'ac_service',
      nameAr: 'مكرر',
      nameEn: 'Again',
      categoryId: await d.categoryId(s.c, 'ac'),
    };
    const dup = await manage('post', '', body).expect(409);
    expect(dup.body).toMatchObject({
      code: 'DUPLICATE_RESOURCE',
      fields: [{ field: 'key', code: 'DUPLICATE_VALUE' }],
    });
    // Another compound's category is not this one's.
    const other = await d.setUp(0);
    const foreign = await manage('post', '', {
      ...body,
      key: 'pool_check',
      categoryId: await d.categoryId(other.c, 'ac'),
    }).expect(400);
    expect((foreign.body as { fields: unknown[] }).fields).toEqual([
      { field: 'categoryId', code: 'CATEGORY_NOT_AVAILABLE' },
    ]);
    // The same key is free there.
    expect((await offered(other)).map((x) => x.key)).toEqual(DEFAULTS);
  });

  it('a service whose category is retired is no longer offered, and comes back with it', async () => {
    const carpentry = await d.categoryId(s.c, 'carpentry');
    const created = await manage('post', '', {
      key: 'doors_check',
      nameAr: 'فحص الأبواب',
      nameEn: 'Doors check',
      categoryId: carpentry,
    }).expect(201);
    const { id } = created.body as Service;
    const setCategory = (active: boolean) =>
      d
        .http(
          'patch',
          `/maintenance/categories/${carpentry}`,
          s.manager.token,
          { active },
        )
        .expect(200);
    await setCategory(false);
    expect((await offered()).map((x) => x.id)).not.toContain(id);
    // Renaming it does not need its retired category to be active.
    await manage('patch', `/${id}`, { nameEn: 'Door check' }).expect(200);
    await setCategory(true);
    expect((await offered()).map((x) => x.id)).toContain(id);
  });

  it('the backfill is safe to run again, and skips a service whose category a compound does not have', async () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../prisma/migrations/20261014090700_preventive_services/migration.sql',
      ),
      'utf8',
    );
    const backfill = sql.slice(sql.lastIndexOf('DO $$'));
    const odd = await d.setUp(0);
    const db = new Client({
      connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
    });
    await db.connect();
    const keys = async () =>
      (
        await db.query<{ key: string }>(
          `SELECT key FROM preventive_services WHERE tenant_id = $1
            ORDER BY position, key`,
          [odd.c.tenantId],
        )
      ).rows.map((r) => r.key);
    try {
      // Again, over everything already there: nothing changes.
      await db.query(backfill);
      expect(await keys()).toEqual(DEFAULTS);
      // A compound that lost its `ac` category and its services (which
      // the app can never do) gets the other three, quietly.
      await db.query(`DELETE FROM preventive_services WHERE tenant_id = $1`, [
        odd.c.tenantId,
      ]);
      await db.query(
        `UPDATE ticket_categories SET key = 'ac_gone'
          WHERE tenant_id = $1 AND key = 'ac'`,
        [odd.c.tenantId],
      );
      await db.query(backfill);
      expect(await keys()).toEqual(DEFAULTS.filter((k) => k !== 'ac_service'));
    } finally {
      await db.end();
    }
  });
});
