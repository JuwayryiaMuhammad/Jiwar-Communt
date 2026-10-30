import { Client } from 'pg';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { childrenHelpers, type ExitBody, type Who } from '../setup/children';
import { whileShiftEnds } from '../setup/shift-end';
import { required } from '../setup/test-env';

const codeOf = (res: { body: unknown }) => (res.body as { code?: string }).code;

/**
 * ADR 0054, decided one at a time on the child's control: two escorts
 * scanned at once, an escort revoked or deactivated while a scan is in
 * flight (both orders), a card reissued or a control turned off under a
 * scan, a refused attempt then a valid one, two turn-ons. Never a deadlock,
 * never a pickup by someone who was no longer allowed when it was decided.
 * An exit while the guard's shift ends takes the account, then the shift,
 * FOR SHARE (ADR 0056's lock order): it waits and is refused.
 */
describe('Children under concurrency', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof childrenHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof childrenHelpers>['setUp']>>;
  let db: Client;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = childrenHelpers(h);
    s = await x.setUp('Children Race Court');
    db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  async function scene() {
    const t = await x.controlled(s.c);
    const a = await x.addEscort(
      t.primary,
      t.home.id,
      t.memberId,
      x.outside('Alpha One'),
    );
    const b = await x.addEscort(
      t.primary,
      t.home.id,
      t.memberId,
      x.outside('Bravo Two'),
    );
    return {
      ...t,
      card: t.control.card.qrPayload,
      a,
      b,
      guard: await x.guardOnDuty(s.c),
    };
  }

  /** Holds the control's row, as a transaction in flight would. */
  async function holding(controlId: string) {
    const held = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await held.connect();
    await held.query('BEGIN');
    await held.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      s.c.tenantId,
    ]);
    await held.query(`SELECT id FROM child_controls WHERE id = $1 FOR UPDATE`, [
      controlId,
    ]);
    return held;
  }
  const settle = async (held: Client, sql?: string, params: unknown[] = []) => {
    if (sql) await held.query(sql, params);
    await held.query('COMMIT');
    await held.end();
  };
  /** Waits until `n` requests wait on a lock. */
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
  const pickups = (controlId: string) =>
    x.inTx(s.c, (tx) => tx.childPickup.findMany({ where: { controlId } }));
  const escortRow = (id: string) =>
    x.inTx(s.c, (tx) => tx.childEscort.findUniqueOrThrow({ where: { id } }));

  it('two escorts scanned at once for one child: one exit, the other 409', async () => {
    for (let i = 0; i < 4; i++) {
      const t = await scene();
      const other = await x.guardOnDuty(s.c);
      const results = await Promise.all([
        x.exitRaw(t.guard, t.card, { code: t.a.pickup!.code }),
        x.exitRaw(other, t.card, { qr: t.b.pickup!.qrPayload }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(codeOf(results.find((r) => r.status === 409)!)).toBe(
        'CHILD_JUST_PICKED_UP',
      );
      const rows = await pickups(t.control.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('picked_up');
    }
  });

  it('one escort scanned twice at once: one record, the other answer replays it', async () => {
    const t = await scene();
    const other = await x.guardOnDuty(s.c);
    const results = await Promise.all([
      x.exitRaw(t.guard, t.card, { code: t.a.pickup!.code }),
      x.exitRaw(other, t.card, { code: t.a.pickup!.code }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect((results[0].body as ExitBody).pickupId).toBe(
      (results[1].body as ExitBody).pickupId,
    );
    expect(await pickups(t.control.id)).toHaveLength(1);
  });

  it('an escort revoked while a scan waits: the revocation first refuses it (escort_inactive), with the alert', async () => {
    const t = await scene();
    const held = await holding(t.control.id);
    const pending = send(
      x.exitRaw(t.guard, t.card, { code: t.a.pickup!.code }),
    );
    await waiters(1);
    await settle(
      held,
      `UPDATE child_escorts
          SET revoked_at = now(), revoke_reason = 'household', revoked_by_account_id = $2,
              pickup_code_hash = NULL, pickup_qr_hash = NULL, pickup_issued_at = NULL
        WHERE id = $1`,
      [t.a.id, t.primary.id],
    );
    const exit = (await pending).body as ExitBody;
    expect(exit).toMatchObject({
      result: 'refused',
      reason: 'escort_inactive',
      escort: { kind: 'outside' },
    });
    expect(await x.told(s.c, t.primary.id, exit.pickupId)).toEqual([
      { kind: 'child.unauthorized_pickup', params: {} },
    ]);
  });

  it('a scan that took the control first: the exit stands, the revocation follows', async () => {
    const t = await scene();
    const held = await holding(t.control.id);
    const exit = send(x.exitRaw(t.guard, t.card, { code: t.a.pickup!.code }));
    await waiters(1);
    const revoke = send(
      x.http(
        'post',
        `${x.escortsPath(t.home.id, t.memberId)}/${t.a.id}/revoke`,
        t.primary.token,
      ),
    );
    await waiters(2);
    await settle(held);
    const [e, r] = await Promise.all([exit, revoke]);
    expect(e.status).toBe(201);
    expect((e.body as ExitBody).outcome).toBe('picked_up');
    expect(r.status).toBe(204);
    const [row] = await pickups(t.control.id);
    expect(
      (await escortRow(t.a.id)).revokedAt!.getTime(),
    ).toBeGreaterThanOrEqual(row.at.getTime());
  });

  it('a card reissued, or the control turned off, under a scan: unknown card, nothing recorded', async () => {
    for (const sql of [
      `UPDATE child_controls SET card_token_hash = repeat('f', 64),
              card_issued_at = card_issued_at + interval '1 millisecond' WHERE id = $1`,
      `UPDATE child_controls SET ended_at = now(), end_reason = 'household', ended_by_account_id = $2,
              card_token_hash = NULL, card_issued_at = NULL WHERE id = $1`,
    ]) {
      const t = await scene();
      const held = await holding(t.control.id);
      const pending = send(
        x.exitRaw(t.guard, t.card, { code: t.a.pickup!.code }),
      );
      await waiters(1);
      await settle(
        held,
        sql,
        sql.includes('$2') ? [t.control.id, t.primary.id] : [t.control.id],
      );
      const res = await pending;
      expect([res.status, codeOf(res)]).toEqual([404, 'CHILD_CARD_UNKNOWN']);
      expect(await pickups(t.control.id)).toEqual([]);
    }
  });

  it('an adult escort deactivated while their scan waits, and the other way round: never a deadlock, never a pickup after the revocation', async () => {
    const deactivate = (who: Who) =>
      x.http('patch', `/accounts/${who.id}/status`, s.manager.token, {
        status: 'inactive',
      });
    // The scan first: it resolved the person, then waited on the control;
    // the deactivation holds the account and waits on the control after it.
    {
      const t = await scene();
      const member = await x.family(s.c, t.home.id, t.primary);
      const escort = await x.addEscort(t.primary, t.home.id, t.memberId, {
        kind: 'adult',
        accountId: member.id,
      });
      const qr = await x.entryQr(member);
      const held = await holding(t.control.id);
      const exit = send(x.exitRaw(t.guard, t.card, { qr }));
      await waiters(1);
      const off = send(deactivate(member));
      await waiters(2);
      await settle(held);
      const [e, d] = await Promise.all([exit, off]);
      expect([e.status, (e.body as ExitBody).outcome]).toEqual([
        201,
        'picked_up',
      ]);
      expect(d.status).toBe(200);
      expect((await escortRow(escort.id)).revokeReason).toBe('left_household');
    }
    // The deactivation first: it holds the account and waits on the
    // control; the scan resolved the person, then waits behind it.
    {
      const t = await scene();
      const member = await x.family(s.c, t.home.id, t.primary);
      const escort = await x.addEscort(t.primary, t.home.id, t.memberId, {
        kind: 'adult',
        accountId: member.id,
      });
      const qr = await x.entryQr(member);
      const held = await holding(t.control.id);
      const off = send(deactivate(member));
      await waiters(1);
      const exit = send(x.exitRaw(t.guard, t.card, { qr }));
      await waiters(2);
      await settle(held);
      const [d, e] = await Promise.all([off, exit]);
      expect(d.status).toBe(200);
      expect((await escortRow(escort.id)).revokeReason).toBe('left_household');
      // Refused (the escort revoked under the lock), or the person no
      // longer known when the scan resolved them: never picked up.
      if (e.status === 201)
        expect(e.body as ExitBody).toMatchObject({
          outcome: 'refused',
          reason: 'escort_inactive',
        });
      else expect([e.status, codeOf(e)]).toEqual([422, 'CHILD_ESCORT_UNKNOWN']);
      expect(
        (await pickups(t.control.id)).filter((p) => p.outcome === 'picked_up'),
      ).toEqual([]);
    }
  });

  it('a refused attempt never blocks a valid pickup right after it', async () => {
    const t = await scene();
    const refused = await x.exit(t.guard, t.card, { unidentified: true });
    expect(refused.outcome).toBe('refused');
    const ok = await x.exit(t.guard, t.card, { code: t.a.pickup!.code });
    expect(ok).toMatchObject({ result: 'authorized', outcome: 'picked_up' });
  });

  it('two turn-ons at once: one control', async () => {
    for (let i = 0; i < 4; i++) {
      const home = await x.unit(s.c, 'C');
      const primary = await x.owner(s.c, home.id);
      const memberId = await x.minor(primary, home.id);
      const results = await Promise.all([
        x.turnOnRaw(primary, home.id, memberId),
        x.turnOnRaw(primary, home.id, memberId),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(codeOf(results.find((r) => r.status === 409)!)).toBe(
        'CHILD_CONTROL_ACTIVE',
      );
      expect(
        await x.inTx(s.c, (tx) =>
          tx.childControl.count({ where: { memberId, endedAt: null } }),
        ),
      ).toBe(1);
    }
  });

  it('an exit while the guard’s shift ends: it waits for the end, then is refused', async () => {
    const t = await scene();
    const res = await whileShiftEnds(t.guard.shiftId, () =>
      x.exitRaw(t.guard, t.card, { code: t.a.pickup!.code }),
    );
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('NO_OPEN_SHIFT');
    expect(await pickups(t.control.id)).toHaveLength(0);
  });
});
