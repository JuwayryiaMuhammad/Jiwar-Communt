import { Client } from 'pg';
import { DispatchSweep } from '../../src/maintenance/dispatch/dispatch-sweep';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { required } from '../setup/test-env';

/**
 * ADR 0033: the compound's dispatch lock orders the engine's decisions, so
 * it must be held for ONE decision, not for a batch: every transaction that
 * wants it (a resident's ticket, a decline) holds a pool connection while it
 * waits, and Prisma's interactive transactions expire after 10 s. The lock
 * is transaction-scoped, so that is asserted on the transactions that wrote
 * the decisions, which no machine's speed changes; how long any single
 * transaction held the lock is measured from outside and reported.
 */
describe('Dispatch — how long the dispatch lock is held', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let probe: Client;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    probe = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await probe.connect();
  }, 60_000);

  afterAll(async () => {
    await probe.end();
    await h.close();
  });

  /**
   * Longest continuous time one transaction was seen holding the compound's
   * dispatch lock (and only that one: another suite's holder is not this
   * compound's), on the database's clock, so a slow round trip of the probe
   * does not count as holding. The advisory key sits in pg_locks as classid
   * (high 32 bits) and objid. A report, not a proof: a poll can miss a
   * short transaction, and a loaded machine stretches a decision.
   */
  async function watchLocks<T>(
    tenantId: string,
    work: () => Promise<T>,
  ): Promise<{ result: T; maxHoldMs: number; holders: number }> {
    const seen = new Map<string, { first: number; last: number }>();
    let stop = false;
    const poller = (async () => {
      while (!stop) {
        const { rows } = await probe.query<{ vxid: string; at: number }>(
          `SELECT DISTINCT virtualtransaction AS vxid,
                  extract(epoch FROM clock_timestamp()) * 1000 AS at
             FROM pg_locks
            WHERE locktype = 'advisory' AND granted
              AND ((classid::bigint << 32) | objid::bigint)
                  = hashtextextended('maintenance.dispatch:' || $1::text, 0)`,
          [tenantId],
        );
        for (const { vxid, at } of rows) {
          const now = Number(at);
          const known = seen.get(vxid);
          if (known) known.last = now;
          else seen.set(vxid, { first: now, last: now });
        }
        // Polling in a tight loop would itself load the database.
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    try {
      const result = await work();
      stop = true;
      await poller;
      const holds = [...seen.values()].map((s) => s.last - s.first);
      return {
        result,
        maxHoldMs: Math.round(Math.max(0, ...holds)),
        holders: holds.length,
      };
    } finally {
      stop = true;
      await poller;
    }
  }

  it('a sweep over a queue of 60 holds it for one decision at a time', async () => {
    const s = await d.setUp(3);
    const category = await d.categoryId(s.c, 'general');
    await d
      .http(
        'put',
        `/maintenance/categories/${category}/specialties`,
        s.manager.token,
        {
          specialtyIds: [],
        },
      )
      .expect(204);
    await d.setAutoDispatch(s.c, true);
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push(await d.openTicket(s));
    // Available, but no event told the engine: only the sweep finds them.
    for (const t of s.techs) await d.setAvailability(s.c, t.id, 'available');

    const started = Date.now();
    const { result, maxHoldMs, holders } = await watchLocks(s.c.tenantId, () =>
      h.moduleRef.get(DispatchSweep).run(),
    );
    const took = Date.now() - started;
    process.stdout.write(
      `dispatch lock: sweep of 60 took ${took} ms; ${holders} transactions held an advisory lock, the longest for ${maxHoldMs} ms\n`,
    );
    expect(result).toBeGreaterThanOrEqual(60);
    const rows = await Promise.all(ids.map((id) => d.ticketRow(s.c, id)));
    expect(rows.every((r) => r.status === 'assigned')).toBe(true);
    // One decision per transaction: each of the sweep's 60 attempt rows was
    // written by a transaction of its own (xmin). Holding the lock across
    // a batch wrote a batch's rows in one.
    const [writers] = await d.inTenant(
      s.c,
      (tx) =>
        tx.$queryRaw<{ rows: number; transactions: number }[]>`
        SELECT count(*)::int AS rows,
               count(DISTINCT xmin::text)::int AS transactions
          FROM ticket_dispatch_attempts
         WHERE ticket_id = ANY(${ids}::uuid[]) AND trigger = 'sweep'`,
    );
    expect(writers).toEqual({ rows: 60, transactions: 60 });
  }, 120_000);
});
