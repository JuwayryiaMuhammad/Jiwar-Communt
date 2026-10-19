import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0055, budget vs actual: per line, budgeted, increases, allowance,
 * actual (live expenses) and what is left, the totals; the CSV twin with
 * the totals last. Read with finance.reports.
 */
describe('Finance — budget vs actual (ADR 0055)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let budget: BudgetBody;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    s = await f.setUp(4, 3);
  }, 240_000);

  afterAll(() => h.close());

  const board = () => [s.owners[0], s.owners[1]];

  it('without an active budget for the year: BUDGET_NOT_FOUND', async () => {
    const res = await f
      .http(
        'get',
        '/staff/finance/reports/budget-vs-actual',
        s.accountant.token,
      )
      .expect(404);
    expect((res.body as { code: string }).code).toBe('BUDGET_NOT_FOUND');
  });

  it('the active budget’s lines with what was spent, and the totals', async () => {
    budget = await f.activeBudget(s.accountant, board(), [
      { category: 'security', amount: '1000.00' },
      { category: 'cleaning', amount: '400.00' },
    ]);
    const cleaning = budget.lines.find((l) => l.category === 'cleaning')!;
    const inc = await f.raise(s.accountant, {
      type: 'budget_increase',
      budgetLineId: cleaning.id,
      cost: '100.00',
    });
    await f.approve(board(), inc.id);
    expect((await f.expense(s.accountant, cleaning.id, '125.00')).status).toBe(
      201,
    );
    const voided = await f.expense(s.accountant, cleaning.id, '50.00');
    await f
      .http(
        'post',
        `/staff/finance/expenses/${(voided.body as { id: string }).id}/void`,
        s.accountant.token,
        {
          reasonCode: 'duplicate',
        },
      )
      .expect(200);
    const res = await f
      .http(
        'get',
        '/staff/finance/reports/budget-vs-actual',
        s.accountant.token,
      )
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      budgetId: budget.id,
      fiscalYear: budget.fiscalYear,
      currency: 'EGP',
      rows: [
        {
          category: 'security',
          budgeted: '1000.00',
          increases: '0.00',
          allowance: '1000.00',
          actual: '0.00',
          remaining: '1000.00',
          usedPct: '0.0',
        },
        {
          category: 'cleaning',
          budgeted: '400.00',
          increases: '100.00',
          allowance: '500.00',
          actual: '125.00',
          remaining: '375.00',
          usedPct: '25.0',
        },
      ],
      totals: {
        budgeted: '1400.00',
        increases: '100.00',
        allowance: '1500.00',
        actual: '125.00',
        remaining: '1375.00',
        usedPct: '8.3',
      },
    });
  });

  it('the CSV: the same rows, the totals last, a byte-order mark and CRLF', async () => {
    const res = await f
      .http(
        'get',
        '/staff/finance/reports/budget-vs-actual/export',
        s.manager.token,
      )
      .expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="budget-vs-actual-${budget.fiscalYear}.csv"`,
    );
    const text = res.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1).split('\r\n')).toEqual([
      'category,budgeted,increases,allowance,actual,remaining,used_pct',
      'security,1000.00,0.00,1000.00,0.00,1000.00,0.0',
      'cleaning,400.00,100.00,500.00,125.00,375.00,25.0',
      'all,1400.00,100.00,1500.00,125.00,1375.00,8.3',
      '',
    ]);
  });

  it('read with finance.reports: the accountant and the manager; not an owner or a board member', async () => {
    for (const who of [s.owners[0], s.owners[3]])
      await f
        .http('get', '/staff/finance/reports/budget-vs-actual', who.token)
        .expect(403);
  });
});
