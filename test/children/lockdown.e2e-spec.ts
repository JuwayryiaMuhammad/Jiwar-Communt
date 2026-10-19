import { Client } from 'pg';
import { childrenHelpers, type ExitBody, type Who } from '../setup/children';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { required } from '../setup/test-env';

/**
 * ADR 0054 under ADR 0053: while a lockdown holds the guard's gate (that
 * gate's own, or every gate's), an outside escort takes no child out —
 * refused with reason `lockdown`, recorded, the household told and not the
 * keepers. The household's adults and the unit's workers still collect
 * the child. A lockdown that starts during an exit either waits for it or
 * is seen by it.
 */
describe('Children — under a lockdown', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof childrenHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof childrenHelpers>['setUp']>>;
  let supervisor: Who;
  let db: Client;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = childrenHelpers(h);
    s = await x.setUp('Lockdown Children Court');
    supervisor = await x.staff(s.c, ['guard_roster.manage']);
    db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  /** `POST /gate/lockdowns` as a guard on shift: the response. */
  const startRaw = (
    guard: Who,
    body: Record<string, unknown> = { scope: 'all' },
  ) =>
    x.http('post', '/gate/lockdowns', guard.token, {
      reasonCode: 'security_threat',
      confirmation: 'LOCKDOWN',
      ...body,
    });
  const start = async (guard: Who, body?: Record<string, unknown>) => {
    const res = await startRaw(guard, body);
    if (res.status !== 201)
      throw new Error(`lockdown: ${res.status} ${JSON.stringify(res.body)}`);
    return (res.body as { id: string }).id;
  };
  const end = (id: string) =>
    x
      .http('post', `/staff/security/lockdowns/${id}/end`, s.manager.token, {
        reasonCode: 'threat_cleared',
      })
      .expect(200);
  /** Ends every live lockdown of the compound (a test that failed half-way). */
  const endAll = async () => {
    const live = await x.inTx(s.c, (tx) =>
      tx.gateLockdown.findMany({
        where: { endedAt: null },
        select: { id: true },
      }),
    );
    for (const l of live) await end(l.id);
  };
  afterEach(() => endAll());

  async function scene() {
    const t = await x.controlled(s.c);
    const member = await x.family(s.c, t.home.id, t.primary);
    await x.addEscort(t.primary, t.home.id, t.memberId, {
      kind: 'adult',
      accountId: member.id,
    });
    const nanny = await x.worker(s.c, t.primary, t.home.id);
    await x.addEscort(t.primary, t.home.id, t.memberId, {
      kind: 'worker',
      engagementId: nanny.engagementId,
    });
    const outside = await x.addEscort(
      t.primary,
      t.home.id,
      t.memberId,
      x.outside('Mona Outside'),
    );
    return {
      ...t,
      card: t.control.card.qrPayload,
      member,
      nanny,
      outside,
      guard: await x.guardOnDuty(s.c),
    };
  }

  it("every gate locked down: an outside escort is refused (lockdown), the household told, not the keepers; the household's adults and workers still collect the child", async () => {
    const t = await scene();
    const lockdown = await start(t.guard);
    const check = await x.verifyRaw(t.guard, t.card).expect(200);
    const shown = (
      check.body as {
        escorts: { id: string; kind: string; validNow: boolean }[];
      }
    ).escorts;
    expect(shown.find((e) => e.id === t.outside.id)?.validNow).toBe(false);
    expect(
      shown.filter((e) => e.kind !== 'outside').every((e) => e.validNow),
    ).toBe(true);

    const refused = await x.exit(t.guard, t.card, {
      code: t.outside.pickup!.code,
    });
    expect(refused).toMatchObject({
      result: 'refused',
      outcome: 'refused',
      reason: 'lockdown',
      escort: { kind: 'outside' },
    });
    expect(await x.told(s.c, t.primary.id, refused.pickupId)).toEqual([
      { kind: 'child.unauthorized_pickup', params: {} },
    ]);
    expect(await x.told(s.c, supervisor.id, refused.pickupId)).toEqual([]);
    // Nor is it among the keepers' alerts.
    const alerts = await x
      .http('get', '/staff/security/child-alerts', supervisor.token)
      .expect(200);
    expect(
      (alerts.body as { data: { id: string }[] }).data.map((a) => a.id),
    ).not.toContain(refused.pickupId);
    await x
      .http(
        'get',
        `/staff/security/child-alerts/${refused.pickupId}`,
        supervisor.token,
      )
      .expect(404);

    const byAdult = await x.exit(t.guard, t.card, {
      qr: await x.entryQr(t.member),
    });
    expect(byAdult).toMatchObject({
      result: 'authorized',
      outcome: 'picked_up',
      escort: { kind: 'adult' },
    });

    // Another child of the same home, collected by the nanny's code.
    const second = await x.minor(t.primary, t.home.id, { years: 6 });
    const control = await x.turnOn(t.primary, t.home.id, second);
    await x.addEscort(t.primary, t.home.id, second, {
      kind: 'worker',
      engagementId: t.nanny.engagementId,
    });
    const byWorker = await x.exit(t.guard, control.card.qrPayload, {
      code: t.nanny.approved!.accessCode,
    });
    expect(byWorker).toMatchObject({
      outcome: 'picked_up',
      escort: { kind: 'worker' },
    });

    // Ended: the outside escort collects the child again.
    await end(lockdown);
    const third = await scene();
    expect(
      await x.exit(third.guard, third.card, {
        code: third.outside.pickup!.code,
      }),
    ).toMatchObject({ outcome: 'picked_up' });
  });

  it('a lockdown of one gate holds that gate only', async () => {
    const t = await scene();
    const other = await x.g.gate(s.c);
    const theirs = await start(t.guard, { scope: 'gate', gateId: other.id });
    expect(
      await x.exit(t.guard, t.card, { code: t.outside.pickup!.code }),
    ).toMatchObject({ outcome: 'picked_up' });
    await end(theirs);
    const u = await scene();
    await start(u.guard, { scope: 'gate', gateId: u.guard.gateId });
    expect(
      await x.exit(u.guard, u.card, { code: u.outside.pickup!.code }),
    ).toMatchObject({ outcome: 'refused', reason: 'lockdown' });
  });

  describe('a lockdown starting against an exit', () => {
    /** Holds a row FOR UPDATE, as a transaction in flight would. */
    async function holding(sql: string, params: unknown[]) {
      const held = new Client({
        connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
      });
      await held.connect();
      await held.query('BEGIN');
      await held.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        s.c.tenantId,
      ]);
      await held.query(sql, params);
      return held;
    }
    const release = async (held: Client) => {
      await held.query('COMMIT');
      await held.end();
    };
    const waiters = async (n: number) => {
      for (let i = 0; i < 100; i++) {
        const res = await db.query(
          `SELECT count(*) FROM pg_locks WHERE NOT granted`,
        );
        if (Number((res.rows[0] as { count: string }).count) >= n) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`fewer than ${n} requests ever waited on a lock`);
    };
    /** Sends now: a supertest request leaves only once it is awaited or then-ed. */
    const send = <T>(req: PromiseLike<T>): Promise<T> =>
      Promise.resolve(req).then((r) => r);

    it('the start first: the exit waits for it, then is refused (lockdown)', async () => {
      const t = await scene();
      const held = await holding(
        `SELECT tenant_id FROM gate_lockdown_states WHERE tenant_id = $1 FOR UPDATE`,
        [s.c.tenantId],
      );
      const starting = send(startRaw(t.guard));
      await waiters(1);
      const exiting = send(
        x.exitRaw(t.guard, t.card, { code: t.outside.pickup!.code }),
      );
      await waiters(2);
      await release(held);
      const [st, ex] = await Promise.all([starting, exiting]);
      expect(st.status).toBe(201);
      expect(ex.status).toBe(201);
      expect(ex.body as ExitBody).toMatchObject({
        outcome: 'refused',
        reason: 'lockdown',
      });
    });

    it('the exit first: the start waits for it, and the child left', async () => {
      const t = await scene();
      // The exit takes the lockdown row FOR SHARE, then waits on the control.
      const held = await holding(
        `SELECT id FROM child_controls WHERE id = $1 FOR UPDATE`,
        [t.control.id],
      );
      const exiting = send(
        x.exitRaw(t.guard, t.card, { code: t.outside.pickup!.code }),
      );
      await waiters(1);
      const starting = send(startRaw(t.guard));
      await waiters(2);
      await release(held);
      const [ex, st] = await Promise.all([exiting, starting]);
      expect(ex.status).toBe(201);
      expect(ex.body as ExitBody).toMatchObject({ outcome: 'picked_up' });
      expect(st.status).toBe(201);
      const [pickup] = await x.inTx(s.c, (tx) =>
        tx.childPickup.findMany({ where: { controlId: t.control.id } }),
      );
      const lockdown = await x.inTx(s.c, (tx) =>
        tx.gateLockdown.findUniqueOrThrow({
          where: { id: (st.body as { id: string }).id },
        }),
      );
      expect(lockdown.startedAt.getTime()).toBeGreaterThanOrEqual(
        pickup.at.getTime(),
      );
    });
  });
});
