import { newId } from '../../src/core/common/uuid';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { TicketsService } from '../../src/maintenance/tickets/tickets.service';
import { err } from '../api/request';
import { day, dbDate, today } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { operationsHelpers, type OperationsSetUp } from '../setup/operations';

interface Economics {
  cumulative: {
    total: string;
    corrective: string;
    planned: string;
    labour: string;
  };
  lastYear: string;
  failures: number;
  downtimeCost: string | null;
  ageYears: number | null;
  lifeYears: number | null;
  replacementYear: number | null;
  advice: string;
  reasons: string[];
  reserve: { annual: string; accrued: string } | null;
}

/**
 * ADR 0065: asset economics and the KPIs, computed on read from the
 * tickets, their costs and the plans' occurrences — two rules for repair
 * or replace, the compound's share setting the second, a capital plan by
 * commissioning year and life, a straight-line reserve.
 */
describe('Operations — asset economics and the KPIs', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof operationsHelpers>;
  let s: OperationsSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = operationsHelpers(h);
    s = await o.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  const year = () => Number(today().slice(0, 4));
  /** An old pump: twelve years in a ten-year life, 1,000 to replace. */
  const oldPump = () =>
    o.asset(s, {
      commissionedOn: `${year() - 12}-01-15`,
      expectedLifeYears: 10,
      replacementCost: '1000',
      downtimeCostPerDay: '100',
    });
  const workOrder = async (
    assetId: string,
    origin: 'field' | 'plan',
    on: OperationsSetUp = s,
  ) => {
    const categoryId = await o.categoryId(on.c, 'plumbing');
    return (
      await o.x.asManager(on.c, () =>
        h.moduleRef.get(TenantTx).withTenantTx((tx) =>
          h.moduleRef.get(TicketsService).createWorkOrder(tx, {
            tenantId: on.c.tenantId,
            origin,
            assetId,
            categoryId,
            priority: 'normal',
            description: `${origin} work`,
            responsibleId: on.supervisor.id,
            actorId: origin === 'plan' ? null : on.supervisor.id,
          }),
        ),
      )
    ).id;
  };
  const cost = (ticketId: string, unitAmount: string) =>
    o
      .http(
        'post',
        `/maintenance/tickets/${ticketId}/costs`,
        s.supervisor.token,
        {
          kind: 'labour',
          description: 'Work',
          quantity: '1',
          unitAmount,
        },
      )
      .expect(201);
  const economics = async (assetId: string) =>
    (
      await o
        .http(
          'get',
          `/maintenance/assets/${assetId}/economics`,
          s.manager.token,
        )
        .expect(200)
    ).body as Economics;

  it('an asset: what it cost, corrective against planned, its downtime, and the advice by rule', async () => {
    const pump = await oldPump();
    const fault = await workOrder(pump, 'field');
    const service = await workOrder(pump, 'plan');
    await cost(fault, '600');
    await cost(service, '150');
    const voided = (await cost(fault, '999').expect(201)).body as {
      id: string;
    };
    await o
      .http(
        'post',
        `/maintenance/ticket-costs/${voided.id}/void`,
        s.supervisor.token,
        {
          reasonCode: 'entered_in_error',
        },
      )
      .expect(200);
    const e = await economics(pump);
    expect(e).toMatchObject({
      cumulative: {
        total: '750.00',
        corrective: '600.00',
        planned: '150.00',
        labour: '750.00',
      },
      lastYear: '750.00',
      failures: 1,
      ageYears: 12,
      lifeYears: 10,
      replacementYear: year() - 2,
      // Past its life, and a year's repairs (750) at half a new one (1,000).
      advice: 'replace',
      reasons: ['past_life_and_costly'],
      reserve: { annual: '100.00', accrued: '1000.00' },
    });
    expect(e.downtimeCost).not.toBeNull();
    // The compound sets the share: at 80 %, 750 is not enough.
    await o
      .http('patch', '/maintenance/settings', s.manager.token, {
        replaceCostSharePct: 80,
      })
      .expect(200);
    expect(await economics(pump)).toMatchObject({
      advice: 'repair',
      reasons: [],
    });
    await o
      .http('patch', '/maintenance/settings', s.manager.token, {
        replaceCostSharePct: 50,
      })
      .expect(200);
    // Who works on assets does not read their money.
    await o
      .http('get', `/maintenance/assets/${pump}/economics`, s.techs[0].token)
      .expect(403);
  });

  it('the compound: spend in the period by month, category and asset; the capital plan and reserve', async () => {
    const pump = await oldPump();
    const fault = await workOrder(pump, 'field');
    await cost(fault, '400');
    const view = (
      await o
        .http(
          'get',
          `/maintenance/economics?from=${day(-1)}&to=${day(0)}`,
          s.manager.token,
        )
        .expect(200)
    ).body as {
      spend: { total: string };
      byCategory: { categoryKey: string; amount: string }[];
      topAssets: { assetId: string; amount: string }[];
      capitalPlan: { year: number; amount: string; assets: number }[];
    };
    expect(Number(view.spend.total)).toBeGreaterThanOrEqual(400);
    expect(view.byCategory.map((c) => c.categoryKey)).toContain('plumbing');
    expect(view.topAssets.map((a) => a.assetId)).toContain(pump);
    // Overdue replacements fall in this year.
    expect(view.capitalPlan[0].year).toBe(year());
    expect(Number(view.capitalPlan[0].amount)).toBeGreaterThanOrEqual(1000);
    expect(view.capitalPlan).toHaveLength(5);
    expect(
      err(
        await o
          .http(
            'get',
            '/maintenance/economics?from=2025-01-01&to=2026-06-01',
            s.manager.token,
          )
          .expect(400),
      ).fields,
    ).toEqual([
      { field: 'from', code: 'PERIOD_TOO_LONG', params: { max: 366 } },
    ]);
  });

  it('the KPIs: planned against corrective, MTTR, failures and schedule compliance', async () => {
    const fresh = await o.setUp(1);
    const asOf = (path: string) =>
      o.http('get', path, fresh.manager.token).expect(200);
    const kpis = async () =>
      (await asOf(`/maintenance/kpis?from=${day(-5)}&to=${day(0)}`)).body as {
        completedPlanned: number;
        completedCorrective: number;
        plannedShare: number | null;
        mttrHours: number | null;
        occurrencesDue: number;
        occurrencesOnTime: number;
        compliance: number | null;
      };
    expect(await kpis()).toMatchObject({
      completedPlanned: 0,
      completedCorrective: 0,
      plannedShare: null,
      compliance: null,
    });
    // One corrective job done.
    const t = await o.startedTicket(fresh);
    await o
      .http('post', `/technician/tickets/${t}/complete`, fresh.techs[0].token)
      .expect(204);
    // A plan with two occurrences due in the period: one on time, one late.
    const assetId = await o.asset(fresh);
    const plan = (
      await o
        .http('post', '/maintenance/plans', fresh.manager.token, {
          assetId,
          title: 'Service',
          trigger: 'calendar',
          every: 1,
          unit: 'month',
          anchorOn: day(20),
        })
        .expect(201)
    ).body as { plan: { id: string } } | { id: string };
    const planId = 'plan' in plan ? plan.plan.id : plan.id;
    const occurrence = async (
      due: string,
      status: 'done' | 'skipped',
      onTime: boolean,
    ) => {
      const ticketId =
        status === 'done' ? await workOrder(assetId, 'plan', fresh) : null;
      await o.inTenant(fresh.c, (tx) =>
        tx.maintenancePlanOccurrence.create({
          data: {
            id: newId(),
            tenantId: fresh.c.tenantId,
            planId,
            originalDueOn: dbDate(due),
            dueOn: dbDate(due),
            status,
            ticketId,
            generatedAt: new Date(),
            closedAt: new Date(),
            ...(status === 'done'
              ? { doneOn: dbDate(due), onTime }
              : { reasonCode: 'not_needed' }),
          },
        }),
      );
    };
    await occurrence(day(-3), 'done', true);
    await occurrence(day(-2), 'done', false);
    await occurrence(day(-1), 'skipped', false);
    const k = await kpis();
    expect(k).toMatchObject({
      completedCorrective: 1,
      completedPlanned: 0,
      plannedShare: 0,
      // Two due (the skipped one left out), one of them on time.
      occurrencesDue: 2,
      occurrencesOnTime: 1,
      compliance: 0.5,
    });
    expect(k.mttrHours).not.toBeNull();
  });
});
