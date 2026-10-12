import { Client } from 'pg';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { AUTO_CLOSE_SWEEP } from '../../src/management/requests/lifecycle.service';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  managementHelpers,
  type ManagementSetUp,
  type Who,
} from '../setup/management';
import { required } from '../setup/test-env';

const DAY = 86_400_000;

/**
 * The races of a request (ADR 0039), run for real: every outcome is one of
 * the allowed ones, and the row, the conversation and the audit trail
 * agree. Where a race hinges on the request's lock, the lock is held from
 * another connection to prove the request waits on it and then decides on
 * what it finds.
 */
describe('Management requests — concurrency', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof managementHelpers>;
  let s: ManagementSetUp;
  let handler: Who;
  let sweep: SweepRunner;
  let db: Client;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = managementHelpers(h);
    s = await m.setUp();
    handler = await m.handler(s.c);
    sweep = h.moduleRef.get(SweepRunner);
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  const ROUNDS = 5;
  const row = (id: string) =>
    m.x.asManager(s.c, () =>
      m.x.prisma.tenant.managementRequest.findUniqueOrThrow({ where: { id } }),
    );
  const audits = (id: string, action: string) =>
    m.x.asManager(s.c, () =>
      m.x.prisma.tenant.auditLog.count({ where: { action, targetId: id } }),
    );
  const messages = (id: string) =>
    m.x.asManager(s.c, () =>
      m.x.prisma.tenant.managementRequestMessage.findMany({
        where: { requestId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  const staff = (id: string, action: string, body?: object, who = handler) =>
    m.http('post', `/management/requests/${id}/${action}`, who.token, body);
  const mine = (id: string, action: string, body?: object) =>
    m.http('post', `/management-requests/${id}/${action}`, s.owner.token, body);
  const answer = (id: string) =>
    staff(id, 'messages', { body: 'The answer', official: true });
  const open = async () => (await m.open(s.c, s.owner)).id;
  const closedRequest = async () => {
    const id = await open();
    await staff(id, 'close', { reasonCode: 'resolved' }).expect(204);
    return id;
  };

  /** Holds the request's row lock from another connection until settled. */
  async function holding(id: string) {
    const held = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await held.connect();
    await held.query('BEGIN');
    await held.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      s.c.tenantId,
    ]);
    await held.query(
      `SELECT id FROM management_requests WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return held;
  }
  const settle = async (held: Client, sql?: string, params: unknown[] = []) => {
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
    throw new Error('the request never waited on the lock');
  };

  it('two staff close at once: one closes, one is told it is closed; one audit row', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = await open();
      const results = await Promise.all([
        staff(id, 'close', { reasonCode: 'resolved' }),
        staff(id, 'close', { reasonCode: 'duplicate' }, s.manager),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(loser.body).toMatchObject({
        code: 'MANAGEMENT_REQUEST_INVALID_TRANSITION',
        params: { status: 'closed' },
      });
      expect(await audits(id, 'management_request.closed')).toBe(1);
      const winner = results.indexOf(results.find((r) => r.status === 204)!);
      expect((await row(id)).closeReason).toBe(
        winner === 0 ? 'resolved' : 'duplicate',
      );
    }
  });

  it('staff close while the author withdraws: one of the two, never both', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = await open();
      const [closed, withdrawn] = await Promise.all([
        staff(id, 'close', { reasonCode: 'resolved' }),
        mine(id, 'withdraw'),
      ]);
      expect([closed.status, withdrawn.status].sort()).toEqual([204, 409]);
      const r = await row(id);
      expect([r.closeReason, r.closedBySide]).toEqual(
        closed.status === 204
          ? ['resolved', 'staff']
          : ['withdrawn_by_author', 'resident'],
      );
      expect(
        (await audits(id, 'management_request.closed')) +
          (await audits(id, 'management_request.withdrawn')),
      ).toBe(1);
    }
  });

  it('an official reply while staff close: answered then closed, or closed and the reply refused — never an answer on a closed request', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = await open();
      const [reply, close] = await Promise.all([
        answer(id),
        staff(id, 'close', { reasonCode: 'resolved' }, s.manager),
      ]);
      expect(close.status).toBe(204);
      expect([201, 409]).toContain(reply.status);
      const r = await row(id);
      expect(r.status).toBe('closed');
      const thread = await messages(id);
      const official = thread.filter((x) => x.official);
      expect(official).toHaveLength(reply.status === 201 ? 1 : 0);
      // A reply that landed did so before the close, in time and in effect.
      if (reply.status === 201) {
        expect(official[0].createdAt.getTime()).toBeLessThanOrEqual(
          r.closedAt!.getTime(),
        );
        expect(r.answeredAt).toEqual(official[0].createdAt);
      } else expect(r.answeredAt).toBeNull();
      expect(await audits(id, 'management_request.answered')).toBe(
        reply.status === 201 ? 1 : 0,
      );
    }
  });

  it('two first replies at once: both land, the response clock is stamped once, by the earlier', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = await open();
      const results = await Promise.all([
        staff(id, 'messages', { body: 'On it' }),
        staff(id, 'messages', { body: 'Me too' }, s.manager),
      ]);
      expect(results.map((r) => r.status)).toEqual([201, 201]);
      const replies = (await messages(id)).filter(
        (x) => x.senderSide === 'staff',
      );
      expect(replies).toHaveLength(2);
      const r = await row(id);
      expect(r.status).toBe('in_progress');
      expect(r.firstResponseAt).toEqual(replies[0].createdAt);
      expect(r.lastActivityAt).toEqual(replies[1].createdAt);
      expect(await audits(id, 'management_request.started')).toBe(1);
    }
  });

  it('the author reopens twice at once: one new cycle, one message', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = await closedRequest();
      const results = await Promise.all([
        mine(id, 'reopen', { body: 'Again' }),
        mine(id, 'reopen', { body: 'Again' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
      expect(results.find((r) => r.status === 409)!.body).toMatchObject({
        code: 'MANAGEMENT_REQUEST_INVALID_TRANSITION',
        params: { status: 'open' },
      });
      expect(await row(id)).toMatchObject({ status: 'open', cycle: 2 });
      expect((await messages(id)).filter((x) => x.cycle === 2)).toHaveLength(1);
      expect(await audits(id, 'management_request.reopened')).toBe(1);
    }
  });

  it('the author replies while the sweep auto-closes: the request ends in one of the two states, consistently', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = await open();
      await answer(id).expect(201);
      const due = new Date((await row(id)).answeredAt!.getTime() + 8 * DAY);
      const [reply] = await Promise.all([
        mine(id, 'messages', { body: 'Wait' }),
        sweep.run(AUTO_CLOSE_SWEEP, due),
      ]);
      const r = await row(id);
      const autoClosed = await audits(id, 'management_request.auto_closed');
      if (reply.status === 201) {
        // The reply won the row: back in hand, never closed under it.
        expect(r.status).toBe('in_progress');
        expect(autoClosed).toBe(0);
      } else {
        expect(reply.status).toBe(409);
        expect(r).toMatchObject({
          status: 'closed',
          closeReason: 'auto_closed',
        });
        expect(autoClosed).toBe(1);
        expect((await messages(id)).map((x) => x.body)).not.toContain('Wait');
      }
    }
  });

  it('the sweep skips a request someone holds, and takes it on its next run', async () => {
    const id = await open();
    await answer(id).expect(201);
    const due = new Date((await row(id)).answeredAt!.getTime() + 8 * DAY);
    const held = await holding(id);
    // SKIP LOCKED: the sweep returns without waiting, having closed nothing here.
    await sweep.run(AUTO_CLOSE_SWEEP, due);
    await settle(held);
    expect((await row(id)).status).toBe('answered');
    await sweep.run(AUTO_CLOSE_SWEEP, due);
    expect((await row(id)).status).toBe('closed');
  });

  it('a close waits for a reply in flight and then decides on what it finds', async () => {
    const id = await open();
    const held = await holding(id);
    const pending = staff(id, 'close', { reasonCode: 'resolved' }).then(
      (r) => r,
    );
    await waitForLockWaiter();
    // What the holder commits: the request was closed by the author meanwhile.
    await settle(
      held,
      `UPDATE management_requests
          SET status = 'closed', closed_at = now(), close_reason = 'withdrawn_by_author',
              closed_by_side = 'resident', updated_at = now()
        WHERE id = $1`,
      [id],
    );
    const res = await pending;
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'MANAGEMENT_REQUEST_INVALID_TRANSITION',
      params: { status: 'closed' },
    });
    expect((await row(id)).closeReason).toBe('withdrawn_by_author');
  });

  it('a message waits for the request’s lock: it is timed after the lock, never before the status it found', async () => {
    const id = await open();
    const held = await holding(id);
    const pending = mine(id, 'messages', { body: 'Held' }).then((r) => r);
    await waitForLockWaiter();
    const [{ at }] = (
      await held.query<{ at: Date }>(
        `SELECT date_trunc('milliseconds', clock_timestamp()) AS at`,
      )
    ).rows;
    await settle(held);
    expect((await pending).status).toBe(201);
    const [, message] = await messages(id);
    // Read from the database's clock after the lock was released.
    expect(message.createdAt.getTime()).toBeGreaterThanOrEqual(at.getTime());
    expect((await row(id)).lastActivityAt).toEqual(message.createdAt);
  });

  it('two assignments at once leave one assignee and an audit trail that ends on it', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = await open();
      const results = await Promise.all([
        staff(id, 'assign', { assigneeId: handler.id }),
        staff(id, 'assign', { assigneeId: s.manager.id }, s.manager),
      ]);
      expect(results.map((r) => r.status)).toEqual([204, 204]);
      const trail = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.auditLog.findMany({
          where: { action: 'management_request.assigned', targetId: id },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        }),
      );
      expect(trail).toHaveLength(2);
      const changes = trail.map(
        (t) =>
          (t.changes as { assigneeId: { from: string | null; to: string } })
            .assigneeId,
      );
      // A chain: nobody → first → second, whichever order they ran in.
      const first = changes.find((c) => c.from === null)!;
      const second = changes.find((c) => c !== first)!;
      expect(second.from).toBe(first.to);
      expect((await row(id)).assigneeId).toBe(second.to);
    }
  });
});
