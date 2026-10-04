import { Client } from 'pg';
import { LOCK_WAIT_MS } from '../../src/maintenance/dispatch/dispatch-engine';
import { BUSY_BACKOFF_MS } from '../../src/maintenance/dispatch/dispatch-limiter';
import { DispatchSweep } from '../../src/maintenance/dispatch/dispatch-sweep';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { required } from '../setup/test-env';

/**
 * ADR 0033: contention on the compound's dispatch lock must never cost a
 * resident their ticket or starve the database pool. A transaction waiting
 * for the lock holds a pool connection, and Prisma's interactive
 * transactions expire after 10 s, so waiting is bounded, in-process waiters
 * queue in memory, and a compound whose lock is stuck is skipped for a
 * moment instead of each decision waiting out its own timeout.
 */
describe('Dispatch — a stuck dispatch lock', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let db: Client;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
  }, 60_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  /** Holds the compound's dispatch lock from another connection. */
  async function holdLock(tenantId: string) {
    const holder = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      tenantId,
    ]);
    await holder.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('maintenance.dispatch:' || current_setting('app.tenant_id'), 0))`,
    );
    return async () => {
      await holder.query('COMMIT');
      await holder.end();
    };
  }

  async function pool(n = 1) {
    const s = await d.setUp(n);
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
    for (const t of s.techs) await d.setAvailability(s.c, t.id, 'available');
    return s;
  }

  const timed = async <T>(fn: () => Promise<T>) => {
    const t = Date.now();
    const value = await fn();
    return { value, ms: Date.now() - t };
  };

  it('a ticket is created and queued after one bounded wait, never failed', async () => {
    const s = await pool(1);
    const category = await d.categoryId(s.c, 'general');
    const release = await holdLock(s.c.tenantId);
    try {
      const { value, ms } = await timed(() =>
        d
          .http('post', '/tickets', s.owner.token, {
            unitId: s.unit.id,
            categoryId: category,
            description: 'Stuck lock',
          })
          .expect(201),
      );
      expect(value.body).toMatchObject({ status: 'new' });
      // It waited for the lock, and not longer than the bound allows.
      expect(ms).toBeGreaterThanOrEqual(LOCK_WAIT_MS - 200);
      expect(ms).toBeLessThan(LOCK_WAIT_MS + 3000);
      const id = (value.body as { id: string }).id;
      expect(await d.ticketRow(s.c, id)).toMatchObject({
        status: 'new',
        technicianId: null,
      });
      // The engine wrote nothing: the sweep, with the lock free, takes it
      // (once the compound's backoff is over: until then it is skipped).
      await release();
      await new Promise((r) => setTimeout(r, BUSY_BACKOFF_MS + 100));
      await h.moduleRef.get(DispatchSweep).run();
      expect(await d.ticketRow(s.c, id)).toMatchObject({ status: 'assigned' });
    } finally {
      await release().catch(() => undefined);
    }
  }, 30_000);

  it('a burst of creations during the stall: all succeed after one bounded wait, and the pool stays free for everyone else', async () => {
    const s = await pool(2);
    const release = await holdLock(s.c.tenantId);
    try {
      const category = await d.categoryId(s.c, 'general');
      const burst = timed(() =>
        Promise.all(
          Array.from({ length: 15 }, () =>
            d.http('post', '/tickets', s.owner.token, {
              unitId: s.unit.id,
              categoryId: category,
              description: 'Burst',
            }),
          ),
        ),
      );
      // While they wait, a request that needs nothing from dispatch is not
      // held up (their waiting holds no connection but one).
      await new Promise((r) => setTimeout(r, 800));
      const other = await timed(() => d.http('get', '/me', s.manager.token));
      expect(other.value.status).toBe(200);
      expect(other.ms).toBeLessThan(1500);
      const { value: responses, ms } = await burst;
      expect(responses.map((r) => r.status)).toEqual(Array(15).fill(201));
      expect(
        new Set(responses.map((r) => (r.body as { number: string }).number))
          .size,
      ).toBe(15);
      // One bounded wait, then the breaker skips the rest: not 15 of them
      // (15 waits of LOCK_WAIT_MS each, one after the other, were 45 s).
      expect(ms).toBeLessThan(LOCK_WAIT_MS + 3000);
    } finally {
      await release().catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, BUSY_BACKOFF_MS + 100));
    await h.moduleRef.get(DispatchSweep).run();
    const queued = await d.inTenant(s.c, (tx) =>
      tx.ticket.count({ where: { status: 'new' } }),
    );
    expect(queued).toBe(0);
  }, 40_000);

  it('a decline is never held back by the lock: the technician is told at once, the ticket waits for the sweep', async () => {
    const s = await pool(1);
    const id = await d.openTicket(s); // assigned on creation
    expect((await d.ticketRow(s.c, id)).technicianId).toBe(s.techs[0].id);
    const release = await holdLock(s.c.tenantId);
    try {
      const { value, ms } = await timed(() =>
        d.http('post', `/technician/tickets/${id}/decline`, s.techs[0].token, {
          reasonCode: 'other',
        }),
      );
      expect(value.status).toBe(204);
      expect(ms).toBeLessThan(LOCK_WAIT_MS + 3000);
      expect(await d.ticketRow(s.c, id)).toMatchObject({
        status: 'new',
        technicianId: null,
      });
    } finally {
      await release().catch(() => undefined);
    }
  }, 30_000);

  it('a dispatcher’s auto-assign gets a coded 503 instead of a hang', async () => {
    const s = await pool(1);
    await d.setAutoDispatch(s.c, false);
    const id = await d.openTicket(s);
    const release = await holdLock(s.c.tenantId);
    try {
      const { value, ms } = await timed(() =>
        d.http(
          'post',
          `/maintenance/tickets/${id}/auto-assign`,
          s.supervisor.token,
        ),
      );
      expect(value.status).toBe(503);
      expect(value.body).toMatchObject({ code: 'DISPATCH_BUSY' });
      expect(ms).toBeLessThan(LOCK_WAIT_MS + 3000);
    } finally {
      await release().catch(() => undefined);
    }
    // And once the lock is free it works.
    await d
      .http(
        'post',
        `/maintenance/tickets/${id}/auto-assign`,
        s.supervisor.token,
      )
      .expect(200);
  }, 30_000);
});
