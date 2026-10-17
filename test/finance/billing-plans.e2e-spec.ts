import type { Response } from 'supertest';
import { addDays } from '../../src/core/common/slots/day-slots';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { BILLING_SWEEP } from '../../src/finance/billing-plans/billing-plans.service';
import { addMonths } from '../../src/finance/billing-plans/periods';
import { day } from '../setup/facilities';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { month, ofDbDate } from '../setup/compound-clock';

const body = <T>(res: Response) => res.body as T;
const code = (res: Response) => body<{ code: string }>(res).code;

interface PlanBody {
  id: string;
  amount: string;
  active: boolean;
  overrideCount: number;
  nextPeriod: { startsOn: string; endsOn: string; issueOn: string } | null;
}

/**
 * Recurring billing (ADR 0046): a plan bills every unit each period, with
 * per-unit overrides; the sweep issues once per (plan, unit, period).
 */
describe('Finance — billing plans', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;
  /** The compound's first of this month. */
  const thisMonth = () => `${month()}-01`;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    s = await f.setUp('Billing Court');
  });

  afterAll(() => h.close());

  const create = (token: string, over: Record<string, unknown> = {}) =>
    f.http('post', '/staff/billing-plans', token, {
      nameEn: 'Service charge',
      nameAr: 'رسوم الخدمات',
      kind: 'service_charge',
      frequency: 'monthly',
      amount: '1500',
      startsOn: thisMonth(),
      issueDaysBefore: 0,
      dueDaysAfterIssue: 10,
      ...over,
    });
  const sweep = () =>
    h.moduleRef.get(SweepRunner).run(BILLING_SWEEP, new Date());
  const invoicesOf = (c: FinanceSetUp, planId: string) =>
    f.x.asManager(c.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        tx.invoice.findMany({
          where: { planId },
          include: { lines: true },
          orderBy: { number: 'asc' },
        }),
      ),
    );

  it('creates a plan: its terms, and the next period to issue', async () => {
    const res = await create(s.accountant.token).expect(201);
    const plan = body<PlanBody>(res);
    expect(plan).toMatchObject({
      amount: '1500.00',
      active: true,
      overrideCount: 0,
      nextPeriod: {
        startsOn: addMonths(thisMonth(), 1),
        endsOn: addMonths(thisMonth(), 2),
        issueOn: addMonths(thisMonth(), 1),
      },
    });
  });

  it('a plan starts on the first of a month, from this month to a year ahead', async () => {
    const fields = async (startsOn: string) =>
      body<{ fields: unknown[] }>(
        await create(s.manager.token, { startsOn }).expect(400),
      ).fields;
    expect(await fields(`${thisMonth().slice(0, 8)}15`)).toEqual([
      { field: 'startsOn', code: 'INVALID_FORMAT' },
    ]);
    expect(await fields(addMonths(thisMonth(), -1))).toEqual([
      {
        field: 'startsOn',
        code: 'STARTS_ON_OUT_OF_RANGE',
        params: { min: thisMonth(), max: addDays(day(0), 366) },
      },
    ]);
  });

  it('the sweep bills the current period to every unit, once; overrides change the amount or leave a unit out', async () => {
    const c = await f.setUp('Billing Sweep');
    const second = await f.unit(c.c, 'A');
    const third = await f.unit(c.c, 'B');
    const plan = body<PlanBody>(await create(c.manager.token).expect(201));
    await f
      .http(
        'put',
        `/staff/billing-plans/${plan.id}/overrides/${second.id}`,
        c.manager.token,
        {
          amount: '900',
        },
      )
      .expect(200);
    await f
      .http(
        'put',
        `/staff/billing-plans/${plan.id}/overrides/${third.id}`,
        c.manager.token,
        {
          excluded: true,
        },
      )
      .expect(200);
    await sweep();
    const first = await invoicesOf(c, plan.id);
    expect(first.map((i) => [i.unitId, i.total.toFixed(2)]).sort()).toEqual(
      [
        [c.home.id, '1500.00'],
        [second.id, '900.00'],
      ].sort(),
    );
    const next = addMonths(thisMonth(), 1);
    for (const i of first) {
      expect(ofDbDate(i.periodStartsOn!)).toBe(thisMonth());
      expect(ofDbDate(i.periodEndsOn!)).toBe(next);
      expect(ofDbDate(i.dueOn)).toBe(day(10));
      expect(i.createdById).toBeNull();
      expect(i.lines.map((l) => l.descriptionEn)).toEqual([
        `Service charge — ${thisMonth()} – ${addDays(next, -1)}`,
      ]);
    }
    // Two batches: one per amount.
    expect(new Set(first.map((i) => i.batchId)).size).toBe(2);
    // Again: nothing new.
    await sweep();
    expect(await invoicesOf(c, plan.id)).toHaveLength(2);
    // A unit added since is billed for the period on the next run.
    const late = await f.unit(c.c, 'A');
    await sweep();
    const after = await invoicesOf(c, plan.id);
    expect(after).toHaveLength(3);
    expect(after.map((i) => i.unitId)).toContain(late.id);
    // The owner was told.
    expect(
      (await f.notifications(c.c, c.owner.id, 'invoice.issued')).length,
    ).toBe(1);
  });

  it('the next period is billed within its lead days', async () => {
    const c = await f.setUp('Billing Lead');
    const next = addMonths(thisMonth(), 1);
    const plan = body<PlanBody>(
      await create(c.manager.token, {
        startsOn: next,
        issueDaysBefore: 28,
      }).expect(201),
    );
    await sweep();
    const within = day(0) >= addDays(next, -28);
    expect(await invoicesOf(c, plan.id)).toHaveLength(within ? 1 : 0);
  });

  it('a retired plan bills nothing; changes apply to later periods only', async () => {
    const c = await f.setUp('Billing Retire');
    const plan = body<PlanBody>(await create(c.manager.token).expect(201));
    await sweep();
    const changed = await f
      .http('patch', `/staff/billing-plans/${plan.id}`, c.manager.token, {
        amount: '2000',
        active: false,
      })
      .expect(200);
    expect(body<PlanBody>(changed)).toMatchObject({
      amount: '2000.00',
      active: false,
      nextPeriod: null,
    });
    // The issued invoice keeps its amount.
    expect(
      (await invoicesOf(c, plan.id)).map((i) => i.total.toFixed(2)),
    ).toEqual(['1500.00']);
    await f.unit(c.c, 'A');
    await sweep();
    expect(await invoicesOf(c, plan.id)).toHaveLength(1);
    // What a plan bills and when never changes.
    const fixed = await f
      .http('patch', `/staff/billing-plans/${plan.id}`, c.manager.token, {
        frequency: 'annual',
      })
      .expect(400);
    expect(body<{ fields: unknown[] }>(fixed).fields).toEqual([
      { field: 'frequency', code: 'FIELD_NOT_ALLOWED' },
    ]);
  });

  describe('overrides', () => {
    it('an amount or excluded, exactly one; a unit of this compound; removed back to the plan’s terms', async () => {
      const plan = body<PlanBody>(await create(s.manager.token).expect(201));
      const path = (unitId: string) =>
        `/staff/billing-plans/${plan.id}/overrides/${unitId}`;
      const put = (unitId: string, b: object) =>
        f.http('put', path(unitId), s.manager.token, b);
      expect(
        body<{ fields: unknown[] }>(await put(s.home.id, {}).expect(400))
          .fields,
      ).toEqual([{ field: 'amount', code: 'FIELD_REQUIRED' }]);
      expect(
        body<{ fields: unknown[] }>(
          await put(s.home.id, { amount: '1', excluded: true }).expect(400),
        ).fields,
      ).toEqual([{ field: 'excluded', code: 'FIELD_NOT_ALLOWED' }]);
      const set = await put(s.home.id, { amount: '750.5' }).expect(200);
      expect(
        body<{ amount: string; excluded: boolean; unitCode: string }>(set),
      ).toMatchObject({
        unitId: s.home.id,
        unitCode: s.home.code,
        amount: '750.50',
        excluded: false,
      });
      await put(s.home.id, { excluded: true }).expect(200);
      const list = await f
        .http(
          'get',
          `/staff/billing-plans/${plan.id}/overrides`,
          s.accountant.token,
        )
        .expect(200);
      expect(body<{ data: unknown[] }>(list).data).toEqual([
        expect.objectContaining({
          unitId: s.home.id,
          amount: null,
          excluded: true,
        }),
      ]);
      const other = await f.setUp('Billing Elsewhere');
      expect(code(await put(other.home.id, { amount: '1' }).expect(404))).toBe(
        'UNIT_NOT_FOUND',
      );
      await f.http('delete', path(s.home.id), s.manager.token).expect(204);
      expect(
        code(
          await f.http('delete', path(s.home.id), s.manager.token).expect(404),
        ),
      ).toBe('BILLING_OVERRIDE_NOT_FOUND');
    });
  });

  it('a guard neither reads nor keeps plans', async () => {
    const guard = await f.staff(s.c, []);
    await f.http('get', '/staff/billing-plans', guard.token).expect(403);
    await create(guard.token).expect(403);
  });
});
