import { Client } from 'pg';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { day, permitHelpers } from '../setup/permits';
import { required } from '../setup/test-env';

/** Four characters nothing else in a run writes. */
const LAST4 = 'QJZK';

/**
 * Where the last four of a contractor's ID may be (ADR 0049): nowhere. A
 * worker is registered with them (Idempotency-Key and all), let in with
 * them, refused with a wrong one, and the whole database is read, column by
 * column, for them: only a keyed hash may stand for them, and no JSON (the
 * audit, a notification, the outbox, a stored response) carries a key for
 * them either (L2).
 */
describe('Permits — the last four of an ID leave no trace', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let db: Client;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    db = new Client({
      connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
    });
    await db.connect();
  }, 180_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  it('no column of any table holds them, and no JSON names them', async () => {
    const c = await p.setUp('Leaks Court');
    await p.anyTime(c.manager);
    const guard = await p.guardOnDuty(c.c);
    const permit = await p.works(c.alice, c.home.id, {
      startsOn: day(0),
      endsOn: day(1),
      dailyHours: { from: '00:00', to: '23:59' },
    });
    const added = await p.addWorkerRaw(
      c.alice,
      permit.id,
      { idType: 'passport', idLast4: LAST4.toLowerCase() },
      { 'Idempotency-Key': '0192f1c2-7a4b-7c3d-8e9f-0a1b2c3d4e51' },
    );
    expect(added.status).toBe(201);
    const workerId = (added.body as { works: { workers: { id: string }[] } })
      .works.workers[0].id;
    await p.approve(c.manager, permit.id);
    const entry = (last4: string, key: string) =>
      p.http(
        'post',
        '/gate/entries',
        guard.token,
        {
          subjectType: 'permit_worker',
          subjectId: workerId,
          direction: 'in',
          idLast4: last4,
        },
        { 'Idempotency-Key': key },
      );
    await entry('ZZZZ', '0192f1c2-7a4b-7c3d-8e9f-0a1b2c3d4e52').expect(409);
    await entry(LAST4, '0192f1c2-7a4b-7c3d-8e9f-0a1b2c3d4e53').expect(201);

    const columns = await db.query<{ table: string; column: string }>(`
      SELECT c.table_name AS table, c.column_name AS column
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
         AND c.table_name <> '_prisma_migrations'
         AND c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb')`);
    // Tenant tables: this compound's rows (four letters may turn up by
    // chance in the rest of a run's random data); global tables: all.
    const withTenant = new Set(
      (
        await db.query<{ table: string }>(`
          SELECT table_name AS table FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'tenant_id'`)
      ).rows.map((r) => r.table),
    );
    const found: string[] = [];
    for (const { table, column } of columns.rows) {
      const scope = withTenant.has(table) ? `AND tenant_id = $3` : '';
      const params: unknown[] = [`%${LAST4}%`, '%"idLast4"%'];
      if (scope) params.push(c.c.tenantId);
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM "${table}"
          WHERE ("${column}"::text ILIKE $1 OR "${column}"::text ILIKE $2)
          ${scope}`,
        params,
      );
      if (Number(rows[0].n) > 0) found.push(`${table}.${column}`);
    }
    expect(found).toEqual([]);
    // The worker's row holds a hash, and it is theirs.
    const { rows } = await db.query<{ hash: string }>(
      `SELECT id_last4_hash AS hash FROM permit_workers WHERE id = $1`,
      [workerId],
    );
    expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
