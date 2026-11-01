import { DEPUTIES_SWEEP } from '../../src/core/access/deputies.service';
import { daysLater } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { neighboursHelpers, type NeighboursSetUp } from '../setup/neighbours';
import { permitRow } from '../setup/permits-rows';

interface Deputy {
  id: string;
  principalAccountId: string;
  deputyAccountId: string;
  permissions: string[];
  endsAt: string;
  endedAt: string | null;
  endReason: string | null;
  live: boolean;
  role: string;
}

/**
 * ADR 0073: a deputy. The manager names another account to decide in their
 * place for at most 30 days: the deputy gains the permissions, the manager
 * loses them meanwhile, and every action taken through one is audited on
 * the manager's behalf. One live deputy per principal; ended once.
 */
describe('Deputies', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;
  let deputy: { id: string; token: string };

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    deputy = await n.staff(s.c, ['inbox.read']);
  }, 180_000);

  afterAll(() => h.close());

  /** The same time `d` of the compound's days from now (a deputyship ends at an instant). */
  const daysAhead = (d: number) => daysLater(d);
  const inDays = (d: number) => daysAhead(d).toISOString();

  const appoint = (body: Record<string, unknown> = {}) =>
    n.http('post', '/staff/deputies', s.manager.token, {
      deputyAccountId: deputy.id,
      permissions: ['permits.manage'],
      endsAt: inDays(3),
      ...body,
    });

  const end = (id: string, token: string) =>
    n.http('post', `/staff/deputies/${id}/end`, token);

  const pendingPermit = () =>
    n.inTx(s.c, (tx) =>
      permitRow(tx, {
        tenantId: s.c.tenantId,
        unitId: s.homeA.id,
        requestedById: s.alice.id,
      }),
    );

  it('the deputy gains the permission and the manager loses it; what the deputy does is on the manager’s behalf; ended, it goes back', async () => {
    const permit = await pendingPermit();
    await n
      .http('get', `/staff/unit-permits/${permit}`, deputy.token)
      .expect(403);
    const d = (await appoint().expect(201)).body as Deputy;
    expect(d).toMatchObject({
      principalAccountId: s.c.managerId,
      deputyAccountId: deputy.id,
      permissions: ['permits.manage'],
      live: true,
      role: 'principal',
    });
    await n
      .http('get', `/staff/unit-permits/${permit}`, s.manager.token)
      .expect(403);
    await n
      .http('post', `/staff/unit-permits/${permit}/approve`, deputy.token, {})
      .expect(200);
    const entries = await n.inTx(s.c, (tx) =>
      tx.auditLog.findMany({ where: { targetId: permit, actorId: deputy.id } }),
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.onBehalfOfId === s.c.managerId)).toBe(true);
    // The deputy was told; the deputy sees it from its side.
    const told = await n.inTx(s.c, (tx) =>
      tx.notification.findMany({
        where: { kind: 'deputy.appointed', targetId: d.id },
      }),
    );
    expect(told.map((t) => t.accountId)).toEqual([deputy.id]);
    const theirs = (
      (await n.http('get', '/staff/deputies', deputy.token).expect(200))
        .body as { data: Deputy[] }
    ).data;
    expect(theirs.find((x) => x.id === d.id)).toMatchObject({
      role: 'deputy',
      live: true,
    });
    // Both accounts say until when they have one: the guard reads
    // deputyships only then.
    const flags = () =>
      n.inTx(s.c, (tx) =>
        tx.account.findMany({
          where: { id: { in: [s.c.managerId, deputy.id] } },
          select: { deputyUntil: true },
        }),
      );
    expect((await flags()).map((a) => a.deputyUntil?.toISOString())).toEqual([
      d.endsAt,
      d.endsAt,
    ]);
    // Ended by the deputy: the manager decides again, once.
    expect(
      ((await end(d.id, deputy.token).expect(200)).body as Deputy).endReason,
    ).toBe('ended');
    const again = await end(d.id, s.manager.token).expect(409);
    expect(again.body).toMatchObject({
      code: 'DEPUTY_ENDED',
      params: { reason: 'ended' },
    });
    await n
      .http('get', `/staff/unit-permits/${permit}`, s.manager.token)
      .expect(200);
    await n
      .http('get', `/staff/unit-permits/${permit}`, deputy.token)
      .expect(403);
    expect((await flags()).map((a) => a.deputyUntil)).toEqual([null, null]);
    // An action of the manager's own is on nobody's behalf.
    const own = await pendingPermit();
    await n
      .http('post', `/staff/unit-permits/${own}/approve`, s.manager.token, {})
      .expect(200);
    const mine = await n.inTx(s.c, (tx) =>
      tx.auditLog.findMany({ where: { targetId: own } }),
    );
    expect(mine.every((e) => e.onBehalfOfId === null)).toBe(true);
  });

  it('what may not be delegated: oneself, money and the board’s matters, what the role lacks, past 30 days, a resident', async () => {
    const fields = async (body: Record<string, unknown>) =>
      ((await appoint(body).expect(400)).body as { fields: object[] }).fields;
    expect(await fields({ deputyAccountId: s.c.managerId })).toEqual([
      { field: 'deputyAccountId', code: 'INVALID_VALUE' },
    ]);
    for (const p of [
      'finance.invoice',
      'governance.manage',
      'appeals.decide',
      'roles.manage',
      'deputies.manage',
      'tickets.work',
    ])
      expect(await fields({ permissions: [p] })).toEqual([
        {
          field: 'permissions[0]',
          code: 'INVALID_VALUE',
          params: { permission: p },
        },
      ]);
    expect(
      await fields({ permissions: ['permits.manage', 'permits.manage'] }),
    ).toEqual([{ field: 'permissions[1]', code: 'DUPLICATE_VALUE' }]);
    expect(await fields({ endsAt: inDays(31) })).toEqual([
      { field: 'endsAt', code: 'INVALID_VALUE', params: { maxDays: 30 } },
    ]);
    expect(await fields({ deputyAccountId: s.alice.id })).toEqual([
      { field: 'deputyAccountId', code: 'INVALID_VALUE' },
    ]);
    // A staff member names no deputy.
    await n
      .http('post', '/staff/deputies', deputy.token, {
        deputyAccountId: s.c.managerId,
        permissions: ['inbox.read'],
        endsAt: inDays(1),
      })
      .expect(403);
  });

  it('two at once: one deputy is named, the other is refused (3×)', async () => {
    for (let round = 0; round < 3; round++) {
      const res = await Promise.all([appoint(), appoint()]);
      expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(res.find((r) => r.status === 409)!.body).toMatchObject({
        code: 'DEPUTY_ALREADY_SET',
      });
      const made = res.find((r) => r.status === 201)!.body as Deputy;
      await end(made.id, s.manager.token).expect(200);
    }
  });

  it('its time runs out: the sweep ends it as expired and tells both; a stranger never sees it', async () => {
    const d = (await appoint({ endsAt: inDays(1) }).expect(201)).body as Deputy;
    await end(d.id, s.alice.token).expect(404);
    await n.sweep(DEPUTIES_SWEEP, daysAhead(2));
    const row = await n.inTx(s.c, (tx) =>
      tx.accountDeputy.findUniqueOrThrow({ where: { id: d.id } }),
    );
    expect(row).toMatchObject({ endReason: 'expired' });
    const told = await n.inTx(s.c, (tx) =>
      tx.notification.findMany({
        where: { kind: 'deputy.ended', targetId: d.id },
      }),
    );
    expect(told.map((t) => t.accountId).sort()).toEqual(
      [deputy.id, s.c.managerId].sort(),
    );
  });
});
