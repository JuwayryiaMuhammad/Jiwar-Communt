import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { PLAN_SWEEP } from '../../src/maintenance/plans/plan-sweep';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import { dbDate, day, today } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type Plan = {
  id: string;
  nextDueOn: string | null;
  active: boolean;
  usageLastValue: string | null;
  stats: { done: number; onTime: number; overdue: number; open: number };
};

/**
 * ADR 0064: maintenance plans. A calendar plan opens one occurrence and
 * one work order per due date, `lead` days before, whatever runs the
 * sweep and however often; the technician's completion marks it done, on
 * time through the grace; past it, the owner and dispatch hear once. A
 * due date moves or is skipped with a reason; a floating series counts
 * from the day the work ended; a usage plan comes due from its readings.
 */
describe('Assets — maintenance plans', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let s: AssetSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    s = await a.setUp(1);
    await a.specialize(s, s.techs[0], ['plumbing']);
    await a.setAvailability(s.c, s.techs[0].id, 'available');
  }, 90_000);

  afterAll(() => h.close());

  const sweep = () => h.moduleRef.get(SweepRunner).run(PLAN_SWEEP, new Date());
  const plan = async (body: Record<string, unknown>) =>
    (
      await a
        .http('post', '/maintenance/plans', s.manager.token, {
          title: 'Quarterly service',
          trigger: 'calendar',
          every: 3,
          unit: 'month',
          anchorOn: day(2),
          leadDays: 7,
          graceDays: 2,
          ...body,
        })
        .expect(201)
    ).body as Plan;
  const occurrences = (planId: string) =>
    a.inTenant(s.c, (tx) =>
      tx.maintenancePlanOccurrence.findMany({
        where: { planId },
        orderBy: { originalDueOn: 'asc' },
      }),
    );
  const get = async (id: string) =>
    (
      await a
        .http('get', `/maintenance/plans/${id}`, s.manager.token)
        .expect(200)
    ).body as Plan;
  /** Assigned, started, its checklist (if any) submitted, completed. */
  const finish = async (ticketId: string) => {
    await a
      .http('post', `/maintenance/tickets/${ticketId}/assign`, s.supervisor.token, {
        technicianId: s.techs[0].id,
      })
      .expect((r) => expect([204, 409]).toContain(r.status));
    await a.http('post', `/technician/tickets/${ticketId}/start`, s.techs[0].token).expect(204);
    await a
      .http('post', `/technician/tickets/${ticketId}/checklist/submit`, s.techs[0].token)
      .expect((r) => expect([201, 404]).toContain(r.status));
    await a.http('post', `/technician/tickets/${ticketId}/complete`, s.techs[0].token).expect(204);
  };

  it('opens one work order per due date within its lead, however many sweeps; the series goes on', async () => {
    const assetId = await a.asset(s);
    const cl = await a.checklist(s, [
      { kind: 'check', labelAr: 'ت', labelEn: 'Leaks', required: false },
    ]);
    const p = await plan({ assetId, checklistId: cl.id });
    expect(p.nextDueOn).toBe(day(2));
    await Promise.all([sweep(), sweep()]);
    await sweep();
    const [o] = await occurrences(p.id);
    expect(await occurrences(p.id)).toHaveLength(1);
    expect(o).toMatchObject({ status: 'open', dueOn: dbDate(day(2)) });
    const ticket = await a.inTenant(s.c, (tx) =>
      tx.ticket.findUniqueOrThrow({ where: { id: o.ticketId! } }),
    );
    expect(ticket).toMatchObject({
      origin: 'plan',
      assetId,
      kind: 'repair',
      reporterId: s.manager.id,
      createdById: s.manager.id,
      description: 'Quarterly service',
    });
    const run = await a.inTenant(s.c, (tx) =>
      tx.checklistRun.findFirst({ where: { ticketId: ticket.id } }),
    );
    expect(run).toMatchObject({ templateId: cl.id, cycle: 1, assetId });
    expect((await get(p.id)).nextDueOn).not.toBe(day(2));
    // Done in time: on time, and counted.
    await finish(ticket.id);
    const [done] = await occurrences(p.id);
    expect(done).toMatchObject({
      status: 'done',
      onTime: true,
      doneOn: dbDate(today()),
    });
    expect((await get(p.id)).stats).toMatchObject({
      done: 1,
      onTime: 1,
      open: 0,
    });
  });

  it('two sweeps at once never open the same due date twice', async () => {
    for (let round = 0; round < 3; round++) {
      const p = await plan({ assetId: await a.asset(s), anchorOn: day(1) });
      await Promise.all([sweep(), sweep(), sweep()]);
      expect(await occurrences(p.id)).toHaveLength(1);
    }
  });

  it('past its grace: the owner and dispatch hear once; a deferred one may be told again', async () => {
    const p = await plan({
      assetId: await a.asset(s),
      anchorOn: day(0),
      leadDays: 0,
      graceDays: 1,
    });
    await sweep();
    const [o] = await occurrences(p.id);
    // Set it in the past, as time would.
    await a.inTenant(
      s.c,
      (tx) =>
        tx.$executeRaw`UPDATE maintenance_plan_occurrences SET due_on = ${dbDate(day(-3))}::date WHERE id = ${o.id}::uuid`,
    );
    await sweep();
    await sweep();
    const told = await a.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { kind: 'maintenance.plan_overdue', targetId: p.id },
      }),
    );
    expect(told.map((n) => n.accountId).sort()).toEqual(
      [s.manager.id, s.supervisor.id].sort(),
    );
    expect(told[0].params).toEqual({
      assetRef: expect.any(String),
      dueOn: day(-3),
    });
    expect((await get(p.id)).stats.overdue).toBe(1);
    await a
      .http(
        'post',
        `/maintenance/plan-occurrences/${o.id}/defer`,
        s.manager.token,
        {
          toDate: day(5),
          reasonCode: 'parts_unavailable',
        },
      )
      .expect(201)
      .expect((r) =>
        expect(r.body).toMatchObject({ dueOn: day(5), originalDueOn: day(0) }),
      );
    expect((await get(p.id)).stats.overdue).toBe(0);
  });

  it('the next due date moves or is skipped with a reason; a plan turns off and on', async () => {
    const p = await plan({ assetId: await a.asset(s), anchorOn: day(20) });
    await a
      .http('post', `/maintenance/plans/${p.id}/defer`, s.manager.token, {
        toDate: day(30),
      })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('REASON_REQUIRED'));
    await a
      .http('post', `/maintenance/plans/${p.id}/defer`, s.manager.token, {
        toDate: day(-1),
        reasonCode: 'weather',
      })
      .expect(400)
      .expect((r) =>
        expect(r.body.fields).toEqual([
          { field: 'toDate', code: 'INVALID_VALUE' },
        ]),
      );
    const deferred = (
      await a
        .http('post', `/maintenance/plans/${p.id}/defer`, s.manager.token, {
          toDate: day(30),
          reasonCode: 'weather',
        })
        .expect(201)
    ).body as Plan;
    expect(deferred.nextDueOn).toBe(day(30));
    const skipped = (
      await a
        .http('post', `/maintenance/plans/${p.id}/skip`, s.manager.token, {
          reasonCode: 'not_needed',
        })
        .expect(201)
    ).body as Plan;
    expect(skipped.nextDueOn! > day(30)).toBe(true);
    expect(
      (await occurrences(p.id)).map((o) => [o.status, o.reasonCode]),
    ).toEqual([['skipped', 'not_needed']]);
    await a
      .http('post', `/maintenance/plans/${p.id}/deactivate`, s.manager.token, {
        reasonCode: 'no_longer_needed',
      })
      .expect(201);
    await a
      .http('post', `/maintenance/plans/${p.id}/skip`, s.manager.token, {
        reasonCode: 'not_needed',
      })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('MAINTENANCE_PLAN_INACTIVE'));
    expect(
      (
        await a
          .http(
            'post',
            `/maintenance/plans/${p.id}/reactivate`,
            s.manager.token,
          )
          .expect(201)
      ).body,
    ).toMatchObject({
      active: true,
    });
    const kinds = (
      (
        await a
          .http('get', `/maintenance/plans/${p.id}/events`, s.manager.token)
          .expect(200)
      ).body as {
        data: { kind: string }[];
      }
    ).data.map((e) => e.kind);
    expect(kinds).toEqual([
      'reactivated',
      'deactivated',
      'skipped',
      'deferred',
      'created',
    ]);
  });

  it('a floating series counts from the day its work ended (done or cancelled)', async () => {
    const p = await plan({
      assetId: await a.asset(s),
      basis: 'floating',
      every: 30,
      unit: 'day',
      anchorOn: day(0),
      leadDays: 0,
    });
    await sweep();
    expect((await get(p.id)).nextDueOn).toBeNull();
    const [o] = await occurrences(p.id);
    await finish(o.ticketId!);
    expect((await get(p.id)).nextDueOn).toBe(day(30));
    const q = await plan({
      assetId: await a.asset(s),
      basis: 'floating',
      every: 10,
      unit: 'day',
      anchorOn: day(0),
      leadDays: 0,
    });
    await sweep();
    const [c] = await occurrences(q.id);
    await a
      .http(
        'post',
        `/maintenance/tickets/${c.ticketId}/cancel`,
        s.supervisor.token,
        { reasonCode: 'resolved_without_visit' },
      )
      .expect(204);
    expect((await occurrences(q.id))[0]).toMatchObject({
      status: 'cancelled',
      reasonCode: 'ticket_cancelled',
    });
    expect((await get(q.id)).nextDueOn).toBe(day(10));
  });

  it('a usage plan comes due from the readings, once while open', async () => {
    const assetId = await a.asset(s);
    const cl = await a.checklist(s, [
      {
        kind: 'reading',
        labelAr: 'س',
        labelEn: 'Run hours',
        metricKey: 'run_hours',
        unit: 'h',
      },
    ]);
    const p = await plan({
      assetId,
      trigger: 'usage',
      metricKey: 'run_hours',
      usageInterval: '500',
      every: undefined,
      unit: undefined,
      anchorOn: undefined,
    });
    const reading = async (value: string) => {
      const ticketId = await a.jobWithChecklist(s, assetId, cl.id, 'field');
      await a
        .http(
          'put',
          `/technician/tickets/${ticketId}/checklist/items/${cl.items[0].id}`,
          s.techs[0].token,
          { value },
        )
        .expect(200);
      await a
        .http(
          'post',
          `/technician/tickets/${ticketId}/checklist/submit`,
          s.techs[0].token,
        )
        .expect(201);
    };
    await reading('300');
    expect(await occurrences(p.id)).toHaveLength(0);
    await reading('520');
    await reading('600');
    const opened = await occurrences(p.id);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ status: 'open', dueOn: dbDate(today()) });
    expect((await get(p.id)).usageLastValue).toBe('520.0000');
  });

  it('refused with codes: an asset in a unit, an owner who cannot dispatch, a retired asset ends its plans', async () => {
    await a
      .http('post', '/maintenance/plans', s.manager.token, {
        assetId: await a.asset(s, { unitId: s.unit.id }),
        title: 'Unit AC',
        trigger: 'calendar',
        every: 6,
        unit: 'month',
        anchorOn: day(1),
      })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('PLAN_FOR_UNIT_ASSET'));
    await a
      .http('post', '/maintenance/plans', s.manager.token, {
        assetId: await a.asset(s),
        title: 'X',
        trigger: 'calendar',
        every: 1,
        unit: 'month',
        anchorOn: day(1),
        ownerId: s.techs[0].id,
      })
      .expect(400)
      .expect((r) =>
        expect(r.body.fields).toEqual([
          { field: 'ownerId', code: 'PLAN_OWNER_NOT_ELIGIBLE' },
        ]),
      );
    await a
      .http('post', '/maintenance/plans', s.manager.token, {
        assetId: await a.asset(s),
        title: 'X',
        trigger: 'usage',
        every: 1,
      })
      .expect(400)
      .expect((r) =>
        expect(r.body.fields).toEqual([
          { field: 'metricKey', code: 'FIELD_REQUIRED' },
          { field: 'usageInterval', code: 'FIELD_REQUIRED' },
          { field: 'every', code: 'FIELD_NOT_ALLOWED' },
        ]),
      );
    const assetId = await a.asset(s);
    const p = await plan({ assetId });
    await a
      .http('post', `/maintenance/assets/${assetId}/retire`, s.manager.token, {
        reasonCode: 'replaced',
      })
      .expect(201);
    expect((await get(p.id)).active).toBe(false);
    await a
      .http('post', `/maintenance/plans/${p.id}/reactivate`, s.manager.token)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ASSET_RETIRED'));
    // A technician reads plans, never keeps them.
    await a
      .http('get', `/maintenance/plans/${p.id}`, s.techs[0].token)
      .expect(200);
    await a
      .http('post', `/maintenance/plans/${p.id}/skip`, s.techs[0].token, {
        reasonCode: 'not_needed',
      })
      .expect(403);
  });

  it('a plan’s history and occurrences are kept: closed occurrences never change', async () => {
    const p = await plan({
      assetId: await a.asset(s),
      anchorOn: day(0),
      leadDays: 0,
    });
    await sweep();
    const [o] = await occurrences(p.id);
    await finish(o.ticketId!);
    await expect(
      a.inTenant(
        s.c,
        (tx) =>
          tx.$executeRaw`UPDATE maintenance_plan_occurrences SET on_time = false WHERE id = ${o.id}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      a.inTenant(
        s.c,
        (tx) =>
          tx.$executeRaw`DELETE FROM maintenance_plan_events WHERE plan_id = ${p.id}::uuid`,
      ),
    ).rejects.toThrow();
  });
});
