import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import {
  DEBRIS_MISSED_SWEEP,
  MISSED_AFTER_MS,
} from '../../src/gate/permits/fitout/debris-slots.service';
import { auditReaders } from '../setup/audit';
import { dbClock } from '../setup/compound-clock';
import { debrisSlotRow } from '../setup/fitout-rows';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { permitHelpers, workDaysOf, type PermitSetUp } from '../setup/permits';

interface SlotBody {
  id: string;
  day: string;
  window: { from: string; to: string };
  status: string;
  scheduledSide: string;
  doneSide: string | null;
  cancelSide: string | null;
  cancelReason: string | null;
}
interface FitOutBody {
  debrisSlots: SlotBody[];
}

/**
 * A works permit's debris removals (ADR 0074): scheduled by its household
 * or the management on a work day of its period, inside the compound's
 * hours; marked done by the management or a guard on shift once near;
 * missed by the sweep two hours past their window; called off before they
 * start.
 */
describe('Fit-out — debris removals', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  /** An approved works permit of alice's home, and its first work day. */
  async function approved(s: PermitSetUp) {
    const permit = await p.works(s.alice, s.home.id);
    await p.approve(s.manager, permit.id);
    return { permit, day: workDaysOf(await p.rules(s.alice), 1, 1)[0] };
  }
  const schedule = (
    as: { token: string },
    path: string,
    day: string,
    window = { from: '10:00', to: '12:00' },
  ) => p.http('post', `${path}/debris-slots`, as.token, { day, window });
  const slots = (res: { body: unknown }) =>
    (res.body as FitOutBody).debrisSlots;
  const fields = (res: { body: unknown }) =>
    (res.body as { fields: { field: string; code: string }[] }).fields;
  const due = (s: PermitSetUp, permitId: string, endsAt?: Date) =>
    p.v.inTx(s.c, (tx) =>
      debrisSlotRow(tx, {
        tenantId: s.c.tenantId,
        permitId,
        scheduledBy: s.manager.id,
        ...(endsAt
          ? { startsAt: new Date(endsAt.getTime() - 3_600_000), endsAt }
          : {}),
      }),
    );

  it('scheduled by the household and the management: three at once, never overlapping, on a work day of the period inside the hours', async () => {
    const s = await p.setUp('Debris Schedule Court');
    const { permit, day } = await approved(s);
    const mine = `/permits/${permit.id}`;
    const staff = `/staff/unit-permits/${permit.id}`;
    const first = await schedule(s.alice, mine, day).expect(201);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(slots(first)).toEqual([
      expect.objectContaining({
        day,
        window: { from: '10:00', to: '12:00' },
        status: 'scheduled',
        scheduledSide: 'resident',
      }),
    ]);
    // Overlapping another: refused.
    expect(
      fields(
        await schedule(s.manager, staff, day, {
          from: '11:00',
          to: '13:00',
        }).expect(400),
      ),
    ).toEqual([{ field: 'window', code: 'DUPLICATE_VALUE' }]);
    // Outside the compound's hours; too long; a day out of the period.
    expect(
      fields(
        await schedule(s.manager, staff, day, {
          from: '07:00',
          to: '08:00',
        }).expect(400),
      ),
    ).toEqual([
      {
        field: 'window',
        code: 'INVALID_VALUE',
        params: { from: '09:00', to: '17:00' },
      },
    ]);
    expect(
      fields(
        await schedule(s.manager, staff, day, {
          from: '12:00',
          to: '17:00',
        }).expect(400),
      ),
    ).toEqual([
      {
        field: 'window.to',
        code: 'INVALID_VALUE',
        params: { min: 30, max: 240 },
      },
    ]);
    expect(
      fields(await schedule(s.manager, staff, '2099-01-05').expect(400))[0],
    ).toMatchObject({ field: 'day', code: 'DAY_OUT_OF_RANGE' });
    await schedule(s.manager, staff, day, {
      from: '13:00',
      to: '14:00',
    }).expect(201);
    await schedule(s.alice, mine, day, { from: '15:00', to: '16:00' }).expect(
      201,
    );
    expect(
      (
        await schedule(s.alice, mine, day, {
          from: '16:00',
          to: '17:00',
        }).expect(409)
      ).body,
    ).toMatchObject({ code: 'DEBRIS_SLOT_LIMIT', params: { max: 3 } });
    const rows = await read.tenant(s.c.tenantId, {
      action: 'debris_slot.scheduled',
    });
    expect(rows.map((r) => r.metadata)).toContainEqual({
      permitId: permit.id,
      day,
      from: '10:00',
      to: '12:00',
      side: 'resident',
    });
  });

  it('a pending permit has none; another unit’s household reaches none', async () => {
    const s = await p.setUp('Debris Pending Court');
    const permit = await p.works(s.alice, s.home.id);
    const day = workDaysOf(await p.rules(s.alice), 1, 1)[0];
    expect(
      (await schedule(s.alice, `/permits/${permit.id}`, day).expect(409)).body,
    ).toMatchObject({
      code: 'PERMIT_NOT_ACTIVE',
      params: { status: 'pending' },
    });
    const other = await p.v.unit(s.c, 'P2');
    const bob = await p.v.owner(s.c, other.id);
    await schedule(bob, `/permits/${permit.id}`, day).expect(404);
  });

  it('called off before it starts: the household its own, the management any', async () => {
    const s = await p.setUp('Debris Cancel Court');
    const { permit, day } = await approved(s);
    const [own] = slots(
      await schedule(s.alice, `/permits/${permit.id}`, day).expect(201),
    );
    const [staffs] = slots(
      await schedule(s.manager, `/staff/unit-permits/${permit.id}`, day, {
        from: '13:00',
        to: '14:00',
      }).expect(201),
    ).filter((d) => d.scheduledSide === 'staff');
    const cancel = (as: { token: string }, path: string, id: string) =>
      p.http('post', `${path}/debris-slots/${id}/cancel`, as.token, {
        reasonCode: 'plans_changed',
      });
    expect(
      (await cancel(s.alice, `/permits/${permit.id}`, staffs.id).expect(403))
        .body,
    ).toMatchObject({ code: 'PERMIT_NOT_ALLOWED' });
    const after = await cancel(s.alice, `/permits/${permit.id}`, own.id).expect(
      200,
    );
    expect(slots(after).find((d) => d.id === own.id)).toMatchObject({
      status: 'cancelled',
      cancelSide: 'resident',
      cancelReason: 'plans_changed',
    });
    expect(
      (await cancel(s.alice, `/permits/${permit.id}`, own.id).expect(409)).body,
    ).toMatchObject({
      code: 'DEBRIS_SLOT_CLOSED',
      params: { status: 'cancelled' },
    });
    await cancel(
      s.manager,
      `/staff/unit-permits/${permit.id}`,
      staffs.id,
    ).expect(200);
  });

  it('done by the management or a guard on shift once near; never far ahead', async () => {
    const s = await p.setUp('Debris Done Court');
    const { permit, day } = await approved(s);
    const [ahead] = slots(
      await schedule(s.alice, `/permits/${permit.id}`, day).expect(201),
    );
    const done = (id: string) =>
      p.http(
        'post',
        `/staff/unit-permits/${permit.id}/debris-slots/${id}/done`,
        s.manager.token,
      );
    expect((await done(ahead.id).expect(409)).body).toMatchObject({
      code: 'DEBRIS_SLOT_CLOSED',
      params: { status: 'scheduled' },
    });
    const now = await due(s, permit.id);
    expect(
      slots(await done(now).expect(200)).find((d) => d.id === now),
    ).toMatchObject({ status: 'done', doneSide: 'staff' });
    // At the gate: a guard with no shift is refused; on shift, done.
    const atGate = await due(s, permit.id);
    const offDuty = await p.g.guard(s.c);
    const off = await p.v.who(s.c, offDuty.id, 'staff');
    await p
      .http(
        'post',
        `/gate/unit-permits/${permit.id}/debris-slots/${atGate}/done`,
        off.token,
      )
      .expect(403);
    const guard = await p.guardOnDuty(s.c);
    const today = (
      await p
        .http(
          'get',
          `/gate/unit-permits/${permit.id}/debris-slots`,
          guard.token,
        )
        .expect(200)
    ).body as SlotBody[];
    expect(today.map((d) => d.id)).toContain(atGate);
    await p
      .http(
        'post',
        `/gate/unit-permits/${permit.id}/debris-slots/${atGate}/done`,
        guard.token,
      )
      .expect(204);
    const row = await p.v.inTx(s.c, (tx) =>
      tx.permitDebrisSlot.findUniqueOrThrow({ where: { id: atGate } }),
    );
    expect(row).toMatchObject({ status: 'done', doneSide: 'gate' });
  });

  it('missed two hours past its window: the requester and the permits’ staff told, once; a done one stays done', async () => {
    const s = await p.setUp('Debris Missed Court');
    const { permit } = await approved(s);
    const ended = new Date(dbClock().getTime() - MISSED_AFTER_MS - 60_000);
    const missed = await due(s, permit.id, ended);
    const marked = await due(s, permit.id, ended);
    // Marked late, but before the sweep came: done it stays.
    await p
      .http(
        'post',
        `/staff/unit-permits/${permit.id}/debris-slots/${marked}/done`,
        s.manager.token,
      )
      .expect(200);
    const recent = await due(s, permit.id);
    const sweep = () =>
      h.moduleRef.get(SweepRunner).run(DEBRIS_MISSED_SWEEP, dbClock());
    await sweep();
    await sweep();
    const rows = await p.v.inTx(s.c, (tx) =>
      tx.permitDebrisSlot.findMany({
        where: { id: { in: [missed, marked, recent] } },
      }),
    );
    const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(status).toEqual({
      [missed]: 'missed',
      [marked]: 'done',
      [recent]: 'scheduled',
    });
    expect(await p.told(s.c, s.alice.id, permit.id)).toEqual(
      expect.arrayContaining([
        { kind: 'unit_permit.debris_missed', params: {} },
      ]),
    );
    expect(
      (await p.told(s.c, s.manager.id, permit.id)).filter(
        (n) => n.kind === 'unit_permit.debris_missed',
      ),
    ).toHaveLength(1);
  });

  it('a mark and the sweep at once: one of them, never both', async () => {
    const s = await p.setUp('Debris Race Court');
    const { permit } = await approved(s);
    // Ended just past the grace: the mark is refused or the sweep is.
    const ended = new Date(dbClock().getTime() - MISSED_AFTER_MS - 1_000);
    const id = await due(s, permit.id, ended);
    const sweep = h.moduleRef
      .get(SweepRunner)
      .run(DEBRIS_MISSED_SWEEP, dbClock());
    const mark = p.http(
      'post',
      `/staff/unit-permits/${permit.id}/debris-slots/${id}/done`,
      s.manager.token,
    );
    const [, res] = await Promise.all([sweep, mark]);
    const row = await p.v.inTx(s.c, (tx) =>
      tx.permitDebrisSlot.findUniqueOrThrow({ where: { id } }),
    );
    expect(['done', 'missed']).toContain(row.status);
    expect(res.status).toBe(row.status === 'done' ? 200 : 409);
    const audited = await read.tenant(s.c.tenantId, { targetId: id });
    expect(audited.map((r) => r.action)).toEqual([
      row.status === 'done' ? 'debris_slot.done' : 'debris_slot.missed',
    ]);
  });
});
