import { Client } from 'pg';
import { DispatchSweep } from '../../src/maintenance/dispatch/dispatch-sweep';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { required } from '../setup/test-env';

/**
 * ADR 0033: the compound's dispatch lock orders the engine's decisions, so
 * it must be held for ONE decision, not for a batch: every transaction that
 * wants it (a resident's ticket, a decline) holds a pool connection while it
 * waits, and Prisma's interactive transactions expire after 10 s. This
 * measures, from outside, how long any single transaction holds an advisory
 * lock while the sweep works through a queue.
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
   * Longest continuous time one transaction held the compound's dispatch
   * lock (and only that one: another suite's holder is not this compound's).
   * The advisory key sits in pg_locks as classid (high 32 bits) and objid.
   */
  async function watchLocks<T>(
    tenantId: string,
    work: () => Promise<T>,
  ): Promise<{ result: T; maxHoldMs: number; holders: number }> {
    const seen = new Map<string, { first: number; last: number }>();
    let stop = false;
    const poller = (async () => {
      while (!stop) {
        const { rows } = await probe.query<{ vxid: string }>(
          `SELECT DISTINCT virtualtransaction AS vxid FROM pg_locks
            WHERE locktype = 'advisory' AND granted
              AND ((classid::bigint << 32) | objid::bigint)
                  = hashtextextended('maintenance.dispatch:' || $1::text, 0)`,
          [tenantId],
        );
        const now = Date.now();
        for (const { vxid } of rows) {
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
        maxHoldMs: Math.max(0, ...holds),
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
    // One transaction per decision: 60 tickets, 60 holders of the lock.
    expect(holders).toBeGreaterThanOrEqual(60);
    const rows = await Promise.all(ids.map((id) => d.ticketRow(s.c, id)));
    expect(rows.every((r) => r.status === 'assigned')).toBe(true);
    // One decision is tens of milliseconds; a batch is seconds.
    expect(maxHoldMs).toBeLessThan(1000);
  }, 120_000);
});
