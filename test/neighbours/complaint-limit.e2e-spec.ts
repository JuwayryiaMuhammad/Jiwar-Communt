import { Client } from 'pg';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  neighboursHelpers,
  type NeighboursSetUp,
  type Who,
} from '../setup/neighbours';
import { required } from '../setup/test-env';

/**
 * ADR 0042: an author may have five complaints open at once (a setting).
 * The limit holds when filings race, because the compound's counter row
 * serializes them: run for real, and with the counter held from another
 * connection to prove a filing waits on it and then counts what it finds.
 */
describe('Neighbour complaints — the open-complaint limit', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;
  let db: Client;
  let targets: { id: string; code: string }[];

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    targets = [];
    for (let i = 0; i < 4; i++) targets.push(await n.unit(s.c, 'T'));
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  }, 180_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  const ROUNDS = 3;
  const open = (who: Who) =>
    n.x.asManager(s.c, () =>
      n.x.prisma.tenant.neighbourComplaint.count({
        where: {
          authorId: who.id,
          status: { notIn: ['resolved', 'dismissed'] },
        },
      }),
    );
  const rows = (who: Who) =>
    n.x.asManager(s.c, () =>
      n.x.prisma.tenant.neighbourComplaint.findMany({
        where: { authorId: who.id },
        orderBy: { number: 'asc' },
      }),
    );
  /** A fresh author with a home of their own. */
  const author = async () => n.owner(s.c, (await n.unit(s.c, 'X')).id);

  it('the sixth is refused with the limit; closing one frees a place', async () => {
    const who = await author();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push((await n.complain(s.c, who, s.homeB.code)).id);
    const sixth = await n.complainRaw(s.c, who, s.homeB.code).expect(409);
    expect(sixth.body).toMatchObject({
      code: 'NEIGHBOUR_COMPLAINT_LIMIT_REACHED',
      params: { max: 5 },
    });
    // The refusal took no number: the next one filed follows the fifth.
    const before = (await rows(who)).map((r) => r.number);
    await n
      .http('post', `/neighbour-complaints/${ids[0]}/withdraw`, who.token)
      .expect(204);
    const next = await n.complain(s.c, who, s.homeB.code);
    expect(Number(next.number.slice(3))).toBe(Math.max(...before) + 1);
    await n.complainRaw(s.c, who, s.homeB.code).expect(409);
    // A staff dismissal as unfounded frees one too.
    await n
      .onComplaint(s.handler, ids[1], 'dismiss', { reasonCode: 'unfounded' })
      .expect(204);
    await n.complain(s.c, who, s.homeB.code);
  });

  it('the limit is each author’s own, and the compound’s to set', async () => {
    const one = await author();
    const two = await author();
    await n.settings(s.c, s.manager, { maxOpenComplaints: 2 });
    try {
      for (const who of [one, two]) {
        await n.complain(s.c, who, s.homeB.code);
        await n.complain(s.c, who, s.homeB.code);
        expect(
          (await n.complainRaw(s.c, who, s.homeB.code).expect(409)).body,
        ).toMatchObject({ params: { max: 2 } });
      }
      // A lower limit takes nothing away from who is already over it.
      await n.settings(s.c, s.manager, { maxOpenComplaints: 1 });
      expect(await open(one)).toBe(2);
    } finally {
      await n.settings(s.c, s.manager, { maxOpenComplaints: 5 });
    }
  });

  it('eight filings at once with one place left: exactly one is filed', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const who = await author();
      for (let i = 0; i < 4; i++) await n.complain(s.c, who, s.homeB.code);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          n.complainRaw(s.c, who, targets[i % targets.length].code),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([
        201, 409, 409, 409, 409, 409, 409, 409,
      ]);
      for (const r of results.filter((x) => x.status === 409))
        expect(r.body).toMatchObject({
          code: 'NEIGHBOUR_COMPLAINT_LIMIT_REACHED',
          params: { max: 5 },
        });
      expect(await open(who)).toBe(5);
      // Numbers have no gap and no twin: a refusal returned its number.
      const numbers = (await rows(who)).map((r) => r.number);
      expect(new Set(numbers).size).toBe(numbers.length);
    }
  });

  it('ten filings at once from an empty start: five are filed, never six', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const who = await author();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          n.complainRaw(s.c, who, targets[i % targets.length].code),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(5);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      expect(await open(who)).toBe(5);
      // Each filed complaint has its filing row and its first message.
      for (const row of await rows(who)) {
        const [history, messages] = await n.x.asManager(s.c, async () => [
          await n.x.prisma.tenant.neighbourComplaintStatusChange.count({
            where: { complaintId: row.id },
          }),
          await n.x.prisma.tenant.neighbourComplaintMessage.count({
            where: { complaintId: row.id },
          }),
        ]);
        expect([history, messages]).toEqual([1, 1]);
      }
    }
  });

  it('the same Idempotency-Key twice at once files once, and both are answered', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const who = await author();
      const key = { 'Idempotency-Key': `limit-${round}-${Date.now()}` };
      const results = await Promise.all([
        n.complainRaw(s.c, who, s.homeB.code, {}, key),
        n.complainRaw(s.c, who, s.homeB.code, {}, key),
      ]);
      expect(results.map((r) => r.status)).toEqual([201, 201]);
      expect(results[0].body).toEqual(results[1].body);
      expect(await open(who)).toBe(1);
    }
  });

  describe('with the counter held', () => {
    /** Holds the compound's counter row from another connection. */
    async function holdingCounter() {
      const held = new Client({
        connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
      });
      await held.connect();
      await held.query('BEGIN');
      await held.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        s.c.tenantId,
      ]);
      await held.query(
        `SELECT tenant_id FROM neighbour_complaint_counters WHERE tenant_id = $1 FOR UPDATE`,
        [s.c.tenantId],
      );
      return held;
    }
    const settle = async (
      held: Client,
      sql?: string,
      params: unknown[] = [],
    ) => {
      if (sql) await held.query(sql, params);
      await held.query('COMMIT');
      await held.end();
    };
    const waitForLockWaiter = async () => {
      for (let i = 0; i < 100; i++) {
        const waiting = await db.query(
          `SELECT count(*) FROM pg_locks WHERE NOT granted`,
        );
        if (Number((waiting.rows[0] as { count: string }).count) > 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('the filing never waited on the counter');
    };

    it('a filing waits for it, then counts what the holder left: a fifth written meanwhile refuses it', async () => {
      const who = await author();
      const ids: string[] = [];
      for (let i = 0; i < 4; i++)
        ids.push((await n.complain(s.c, who, s.homeB.code)).id);
      const held = await holdingCounter();
      const filing = n.complainRaw(s.c, who, s.homeB.code).then((r) => r);
      await waitForLockWaiter();
      // While it waits, the holder files the fifth by hand.
      const category = await n.categoryId(s.c);
      await settle(
        held,
        `INSERT INTO neighbour_complaints
           (id, tenant_id, number, author_account_id, target_unit_id, category_id, last_activity_at, updated_at)
         VALUES (gen_random_uuid(), $1, 900000, $2, $3, $4, now(), now())`,
        [s.c.tenantId, who.id, s.homeB.id, category],
      );
      const res = await filing;
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'NEIGHBOUR_COMPLAINT_LIMIT_REACHED',
      });
      expect(await open(who)).toBe(5);
    });

    it('a filing waits for it, and is filed when the holder leaves room', async () => {
      const who = await author();
      for (let i = 0; i < 4; i++) await n.complain(s.c, who, s.homeB.code);
      const held = await holdingCounter();
      const filing = n.complainRaw(s.c, who, s.homeB.code).then((r) => r);
      await waitForLockWaiter();
      const before = await held.query(`SELECT clock_timestamp() AS at`);
      await settle(held);
      const res = await filing;
      expect(res.status).toBe(201);
      // Timed when it decided, after the lock: not when it began.
      const created = new Date((res.body as { createdAt: string }).createdAt);
      expect(created.getTime()).toBeGreaterThanOrEqual(
        new Date((before.rows[0] as { at: Date }).at).getTime() - 1,
      );
      expect(await open(who)).toBe(5);
    });
  });
});
