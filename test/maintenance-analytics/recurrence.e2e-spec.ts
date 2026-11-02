import { addDays } from '../../src/maintenance/schedules/local-dates';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import { today } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type Body = {
  code: string;
  fields?: { field: string; code: string; params?: unknown }[];
  params?: Record<string, unknown>;
  [key: string]: unknown;
};

interface Suggestion {
  id: string;
  assetId: string | null;
  unitId: string | null;
  categoryKey: string;
  ticketCount: number;
  status: string;
  planId: string | null;
  planCreated: boolean | null;
  reasonCode: string | null;
}

/**
 * ADR 0081: repeat faults. The analytics' numbers are the manager's,
 * bounded and audited; a category's repairs on an asset of a common area
 * (else in a unit) reaching them make one plan suggestion — once, also
 * when two land together — that is accepted into a plan (a new one, made by
 * the plans' rules; two acceptances at once make one) or one covering it,
 * or dismissed, and not made again within the window. The recurrence
 * report and the complaints map aggregate per place: counts, codes and
 * amounts, never a ticket's words or a person.
 */
describe('Maintenance analytics — repeat faults, plan suggestions and the map', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let s: AssetSetUp;
  let plumbing: string;

  const order = (assetId: string, description = 'Seal leaks') =>
    a.http('post', '/maintenance/work-orders', s.supervisor.token, {
      assetId,
      categoryId: plumbing,
      description,
    });

  const suggestionsOf = (assetId: string) =>
    a.inTenant(s.c, (tx) =>
      tx.maintenancePlanSuggestion.findMany({
        where: { assetId, categoryId: plumbing },
        orderBy: { createdAt: 'asc' },
      }),
    );

  const newPlan = (assetId: string) => ({
    assetId,
    title: 'Monthly seal check',
    trigger: 'calendar',
    every: 1,
    unit: 'month',
    anchorOn: addDays(today(), 7),
  });

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    s = await a.setUp(1);
    plumbing = await a.categoryId(s.c, 'plumbing');
  }, 180_000);

  afterAll(() => h.close());

  describe('the settings', () => {
    it('reads the defaults: 3 in 90 days, 3 in 30 days', async () => {
      const res = await a
        .http('get', '/maintenance/settings/analytics', s.manager.token)
        .expect(200);
      expect(res.body).toEqual({
        recurrenceMinTickets: 3,
        recurrenceWindowDays: 90,
        caseMinTickets: 3,
        caseWindowDays: 30,
      });
    });

    it('refuses a number out of its range, and the supervisor', async () => {
      const res = await a
        .http('patch', '/maintenance/settings/analytics', s.manager.token, {
          recurrenceWindowDays: 400,
        })
        .expect(400);
      expect((res.body as Body).fields?.[0]).toMatchObject({
        field: 'recurrenceWindowDays',
        code: 'INVALID_NUMBER',
      });
      await a
        .http('patch', '/maintenance/settings/analytics', s.supervisor.token, {
          caseMinTickets: 4,
        })
        .expect(403);
    });

    it('a change is audited, from and to', async () => {
      await a
        .http('patch', '/maintenance/settings/analytics', s.manager.token, {
          caseWindowDays: 45,
        })
        .expect(200);
      const [entry] = await a.inTenant(s.c, (tx) =>
        tx.auditLog.findMany({
          where: { action: 'maintenance.analytics_settings_changed' },
        }),
      );
      expect(entry.changes).toEqual({ caseWindowDays: { from: 30, to: 45 } });
    });
  });

  describe('plan suggestions', () => {
    it('the third repair on an asset makes one; who keeps the plans is asked', async () => {
      const assetId = await a.asset(s);
      await order(assetId).expect(201);
      await order(assetId).expect(201);
      expect(await suggestionsOf(assetId)).toEqual([]);
      await order(assetId).expect(201);
      const [one, ...more] = await suggestionsOf(assetId);
      expect(more).toEqual([]);
      expect(one).toMatchObject({
        status: 'open',
        ticketCount: 3,
        windowDays: 90,
      });
      const asked = await a.inTenant(s.c, (tx) =>
        tx.notification.findMany({
          where: { kind: 'maintenance.plan_suggested', targetId: one.id },
        }),
      );
      expect(asked.map((n) => n.accountId)).toEqual(
        expect.arrayContaining([s.manager.id, s.supervisor.id]),
      );
      // In the staff inbox (ADR 0073) for whoever keeps the plans: no bulk
      // approval takes it (its acceptance takes a plan).
      const inbox = (
        (
          await a
            .http('get', '/staff/inbox?type=plan_suggestion', s.manager.token)
            .expect(200)
        ).body as { data: { type: string; id: string }[] }
      ).data.map((r) => [r.type, r.id]);
      expect(inbox).toContainEqual(['plan_suggestion', one.id]);
      // The next fault does not make a second while it is open.
      await order(assetId).expect(201);
      expect(await suggestionsOf(assetId)).toHaveLength(1);
    });

    it('two repairs landing at once at the threshold make one', async () => {
      const assetId = await a.asset(s);
      await order(assetId).expect(201);
      const both = await Promise.all([order(assetId), order(assetId)]);
      expect(both.map((r) => r.status)).toEqual([201, 201]);
      expect(await suggestionsOf(assetId)).toHaveLength(1);
    });

    it('two acceptances at once: one plan, the other PLAN_SUGGESTION_DECIDED', async () => {
      const assetId = await a.asset(s);
      for (let i = 0; i < 3; i++) await order(assetId).expect(201);
      const [sug] = await suggestionsOf(assetId);
      const accept = () =>
        a.http(
          'post',
          `/maintenance/plan-suggestions/${sug.id}/accept`,
          s.manager.token,
          { plan: newPlan(assetId) },
        );
      const both = await Promise.all([accept(), accept()]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      const lost = both.find((r) => r.status === 409)!;
      expect(lost.body as Body).toMatchObject({
        code: 'PLAN_SUGGESTION_DECIDED',
        params: { status: 'accepted' },
      });
      const won = both.find((r) => r.status === 201)!.body as Suggestion;
      expect(won).toMatchObject({ status: 'accepted', planCreated: true });
      const plans = await a.inTenant(s.c, (tx) =>
        tx.maintenancePlan.findMany({ where: { assetId } }),
      );
      expect(plans.map((p) => p.id)).toEqual([won.planId]);
      expect(plans[0].categoryId).toBe(plumbing);
    });

    it('accepted into a plan that covers it: nothing of the plan changes; another asset’s plan is refused', async () => {
      const assetId = await a.asset(s);
      const other = await a.asset(s);
      const plan = (
        await a
          .http('post', '/maintenance/plans', s.manager.token, newPlan(assetId))
          .expect(201)
      ).body as { id: string; title: string; updatedAt: string };
      const elsewhere = (
        await a
          .http('post', '/maintenance/plans', s.manager.token, newPlan(other))
          .expect(201)
      ).body as { id: string };
      for (let i = 0; i < 3; i++) await order(assetId).expect(201);
      const [sug] = await suggestionsOf(assetId);
      const wrong = await a
        .http(
          'post',
          `/maintenance/plan-suggestions/${sug.id}/accept`,
          s.manager.token,
          {
            planId: elsewhere.id,
          },
        )
        .expect(409);
      expect((wrong.body as Body).code).toBe('PLAN_NOT_OF_ASSET');
      const both = await a
        .http(
          'post',
          `/maintenance/plan-suggestions/${sug.id}/accept`,
          s.manager.token,
          {
            planId: plan.id,
            plan: newPlan(assetId),
          },
        )
        .expect(400);
      expect((both.body as Body).fields?.[0]).toMatchObject({
        field: 'plan',
        code: 'FIELD_NOT_ALLOWED',
      });
      const ok = (
        await a
          .http(
            'post',
            `/maintenance/plan-suggestions/${sug.id}/accept`,
            s.manager.token,
            {
              planId: plan.id,
            },
          )
          .expect(201)
      ).body as Suggestion;
      expect(ok).toMatchObject({ planId: plan.id, planCreated: false });
      const after = await a.inTenant(s.c, (tx) =>
        tx.maintenancePlan.findUniqueOrThrow({ where: { id: plan.id } }),
      );
      expect(after.title).toBe(plan.title);
    });

    it('dismissed with a code; not made again within the window', async () => {
      const assetId = await a.asset(s);
      for (let i = 0; i < 3; i++) await order(assetId).expect(201);
      const [sug] = await suggestionsOf(assetId);
      await a
        .http(
          'post',
          `/maintenance/plan-suggestions/${sug.id}/dismiss`,
          s.supervisor.token,
          {},
        )
        .expect(400);
      const res = (
        await a
          .http(
            'post',
            `/maintenance/plan-suggestions/${sug.id}/dismiss`,
            s.supervisor.token,
            {
              reasonCode: 'not_recurring',
            },
          )
          .expect(201)
      ).body as Suggestion;
      expect(res).toMatchObject({
        status: 'dismissed',
        reasonCode: 'not_recurring',
      });
      await order(assetId).expect(201);
      expect(await suggestionsOf(assetId)).toHaveLength(1);
    });

    it('in a unit: its residents’ repeat tickets; a technician may not decide', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++)
        ids.push(await a.openTicket(s, { category: 'plumbing' }));
      const rows = await a.inTenant(s.c, (tx) =>
        tx.maintenancePlanSuggestion.findMany({
          where: { unitId: s.unit.id, categoryId: plumbing },
        }),
      );
      expect(rows).toHaveLength(1);
      const listed = (
        await a
          .http(
            'get',
            '/maintenance/plan-suggestions?status=open',
            s.supervisor.token,
          )
          .expect(200)
      ).body as { data: Suggestion[] };
      expect(listed.data.find((x) => x.id === rows[0].id)).toMatchObject({
        unitId: s.unit.id,
        assetId: null,
        categoryKey: 'plumbing',
      });
      await a
        .http(
          'post',
          `/maintenance/plan-suggestions/${rows[0].id}/dismiss`,
          s.techs[0].token,
          {
            reasonCode: 'other',
          },
        )
        .expect(403);
    });
  });

  describe('the recurrence report', () => {
    it('by asset: the count, the months, the cost; never the words', async () => {
      const assetId = await a.asset(s);
      for (let i = 0; i < 2; i++) await order(assetId).expect(201);
      const res = await a
        .http(
          'get',
          `/maintenance/recurrence?from=${addDays(today(), -30)}&to=${today()}&by=asset&min=2`,
          s.supervisor.token,
        )
        .expect(200);
      const body = res.body as {
        by: string;
        min: number;
        rows: {
          placeId: string;
          placeCode: string;
          categoryKey: string;
          count: number;
          cost: string;
          meanIntervalDays: number;
          months: { month: string; count: number }[];
        }[];
      };
      expect(body).toMatchObject({ by: 'asset', min: 2 });
      const row = body.rows.find((r) => r.placeId === assetId)!;
      expect(row).toMatchObject({
        categoryKey: 'plumbing',
        count: 2,
        cost: '0.00',
      });
      expect(row.months.reduce((n, m) => n + m.count, 0)).toBe(2);
      expect(JSON.stringify(body)).not.toContain('Seal leaks');
    });

    it('by building and by unit, the compound’s threshold by default', async () => {
      const q = `from=${addDays(today(), -30)}&to=${today()}`;
      const byUnit = (
        await a
          .http(
            'get',
            `/maintenance/recurrence?${q}&by=unit`,
            s.supervisor.token,
          )
          .expect(200)
      ).body as { min: number; rows: { placeId: string; placeCode: string }[] };
      expect(byUnit.min).toBe(3);
      expect(byUnit.rows.find((r) => r.placeId === s.unit.id)?.placeCode).toBe(
        s.unit.code,
      );
      const byBuilding = (
        await a
          .http(
            'get',
            `/maintenance/recurrence?${q}&by=building`,
            s.supervisor.token,
          )
          .expect(200)
      ).body as { rows: { placeCode: string }[] };
      expect(byBuilding.rows.map((r) => r.placeCode)).toContain(s.building);
    });

    it('refuses a period over a year and an unknown place', async () => {
      await a
        .http(
          'get',
          '/maintenance/recurrence?from=2025-01-01&to=2026-04-01',
          s.supervisor.token,
        )
        .expect(400);
      const res = await a
        .http(
          'get',
          `/maintenance/recurrence?from=${today()}&to=${today()}&by=floor`,
          s.supervisor.token,
        )
        .expect(400);
      expect((res.body as Body).fields?.[0]).toMatchObject({ field: 'by' });
    });
  });

  describe('the complaints map', () => {
    it('per building (its units’ tickets, the residents’ among them) and per area: counts and codes only', async () => {
      const res = await a
        .http(
          'get',
          `/maintenance/complaints-map?from=${addDays(today(), -30)}&to=${today()}`,
          s.supervisor.token,
        )
        .expect(200);
      const body = res.body as {
        buildings: {
          name: string;
          total: number;
          residents: number;
          categories: { categoryKey: string; count: number }[];
        }[];
        areas: { code: string; total: number }[];
      };
      const tower = body.buildings.find((b) => b.name === s.building)!;
      expect(tower.total).toBeGreaterThanOrEqual(3);
      expect(tower.residents).toBeGreaterThanOrEqual(3);
      expect(tower.categories[0]).toMatchObject({ categoryKey: 'plumbing' });
      expect(body.areas.length).toBeGreaterThan(0);
      const text = JSON.stringify(body);
      expect(text).not.toContain(s.unit.code);
      expect(text).not.toContain('Seal leaks');
      expect(text).not.toContain('Dispatch fixture');
    });

    it('is the dispatch’s: the technician is refused', async () => {
      await a
        .http(
          'get',
          `/maintenance/complaints-map?from=${today()}&to=${today()}`,
          s.techs[0].token,
        )
        .expect(403);
    });
  });
});
