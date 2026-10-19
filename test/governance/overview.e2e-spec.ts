import { budgetHelpers } from '../setup/budgets';
import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface OverviewBody {
  from: string;
  to: string;
  sections: {
    finance: {
      aging: Record<string, string>;
      outstanding: Record<string, string | number>;
      collections: { gross: string; reversed: string; net: string };
      budget: { fiscalYear: number; totals: Record<string, string> } | null;
    };
    security: {
      incidents: Record<string, unknown>;
      violations: Record<string, unknown>;
    };
  };
}

/**
 * ADR 0055, the board's overview: a sitting member's only; the same
 * figures as the existing reports (their totals: never a unit), over a
 * period of up to 31 days, the last 30 by default.
 */
describe('Governance — the board’s overview (ADR 0055)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    s = await f.setUp(4, 3);
    await f.fin.issue(s.manager, s.owners[3].unitId);
    await f.activeBudget(
      s.accountant,
      [s.owners[0], s.owners[1]],
      [{ category: 'security', amount: '1000.00' }],
    );
  }, 240_000);

  afterAll(() => h.close());

  const get = (path: string, token: string) => f.http('get', path, token);

  it('a sitting member reads it; the manager, the accountant and an owner off the board do not', async () => {
    for (const who of [s.manager, s.accountant, s.owners[3]])
      await get('/board/overview', who.token).expect(403);
    const res = await get('/board/overview', s.owners[0].token).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ from: day(-29), to: day(0) });
  });

  it('the same totals as the reports; no unit is named', async () => {
    const body = (
      await get(
        `/board/overview?from=${day(-6)}&to=${day(0)}`,
        s.owners[1].token,
      ).expect(200)
    ).body as OverviewBody;
    const aging = (
      await get(
        '/staff/finance/reports/aging?groupBy=building',
        s.accountant.token,
      ).expect(200)
    ).body as { totals: Record<string, string> };
    const outstanding = (
      await get(
        '/staff/finance/reports/outstanding?groupBy=building',
        s.accountant.token,
      ).expect(200)
    ).body as { totals: Record<string, string | number> };
    const budget = (
      await get(
        '/staff/finance/reports/budget-vs-actual',
        s.accountant.token,
      ).expect(200)
    ).body as { totals: Record<string, string> };
    expect(body.sections.finance.aging).toEqual(aging.totals);
    expect(body.sections.finance.outstanding).toEqual(outstanding.totals);
    expect(body.sections.finance.budget?.totals).toEqual(budget.totals);
    const incidents = (
      await get(
        `/staff/security/reports/incidents?from=${day(-6)}&to=${day(0)}`,
        s.manager.token,
      ).expect(200)
    ).body as { totals: unknown };
    expect(body.sections.security.incidents).toEqual(incidents.totals);
    const unitCode = (
      await f.inTx(s.c, (tx) =>
        tx.unit.findUniqueOrThrow({ where: { id: s.owners[3].unitId } }),
      )
    ).code;
    expect(JSON.stringify(body)).not.toContain(unitCode);
  });

  it('31 days at most', async () => {
    const res = await get(
      `/board/overview?from=${day(-31)}&to=${day(0)}`,
      s.owners[0].token,
    ).expect(400);
    expect((res.body as { fields: unknown[] }).fields).toEqual([
      { field: 'to', code: 'PERIOD_TOO_LONG', params: { maxDays: 31 } },
    ]);
  });
});
