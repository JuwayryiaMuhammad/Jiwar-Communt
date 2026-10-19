import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0055, the annual budget: drafted by the accountant as lines per
 * category, submitted to the board as an annual_budget request (its total
 * the cost), active only once approved and then the board's announcement
 * to the owners; an approved increase adds to a line. Who may and may not.
 */
describe('Finance — the annual budget (ADR 0055)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    s = await f.setUp(5, 3);
  }, 240_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];
  const board = () => [o(0), o(1), o(2)];
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const idOf = (res: { body: unknown }) => (res.body as { id: string }).id;

  it('the accountant and the manager keep the budget; an owner, a board member and a guard do not', async () => {
    for (const who of [o(0), o(4)])
      await f.http('get', '/staff/finance/budgets', who.token).expect(403);
    await f
      .http('get', '/staff/finance/budgets', s.accountant.token)
      .expect(200);
    await f.http('get', '/staff/finance/budgets', s.manager.token).expect(200);
  });

  describe('a year’s budget, end to end', () => {
    let budget: BudgetBody;
    let requestId: string;

    it('drafted for this year, its lines replaced while a draft; one per category', async () => {
      budget = await f.draft(s.accountant);
      expect(budget).toMatchObject({
        fiscalYear: f.thisYear(),
        startsOn: `${f.thisYear()}-01-01`,
        endsOn: `${f.thisYear()}-12-31`,
        status: 'draft',
        lines: [],
      });
      const twice = await f
        .setLines(s.accountant, budget.id, [
          { category: 'security', amount: '1.00' },
          { category: 'security', amount: '2.00' },
        ])
        .expect(400);
      expect((twice.body as { fields: unknown[] }).fields).toEqual([
        { field: 'lines[1].category', code: 'DUPLICATE_VALUE' },
      ]);
      const set = await f
        .setLines(s.accountant, budget.id, [
          { category: 'landscaping', amount: '120000.00' },
          { category: 'security', amount: '480000.00', note: 'Two shifts' },
        ])
        .expect(200);
      expect((set.body as BudgetBody).lines.map((l) => l.category)).toEqual([
        'security',
        'landscaping',
      ]);
      expect((set.body as BudgetBody).totals.budgeted).toBe('600000.00');
      // A second budget for the year waits for this one.
      expect(
        code(
          await f
            .http('post', '/staff/finance/budgets', s.accountant.token, {
              fiscalYear: f.thisYear(),
            })
            .expect(409),
        ),
      ).toBe('BUDGET_IN_PROGRESS');
    });

    it('submitted as an annual_budget request: the total is its cost; the lines are kept from then', async () => {
      const withCost = await f
        .http('post', '/staff/governance/approvals', s.accountant.token, {
          type: 'annual_budget',
          budgetId: budget.id,
          context: 'c',
          impact: 'i',
          cost: '1.00',
        })
        .expect(400);
      expect((withCost.body as { fields: unknown[] }).fields).toEqual([
        { field: 'cost', code: 'FIELD_NOT_ALLOWED' },
      ]);
      const res = await f.submit(s.accountant, budget.id).expect(201);
      requestId = idOf(res);
      expect(res.body).toMatchObject({
        type: 'annual_budget',
        cost: '600000.00',
        subjectId: budget.id,
      });
      expect((await f.budgetView(s.accountant, budget.id)).status).toBe(
        'submitted',
      );
      expect(
        code(
          await f
            .setLines(s.accountant, budget.id, [
              { category: 'security', amount: '1.00' },
            ])
            .expect(409),
        ),
      ).toBe('BUDGET_NOT_DRAFT');
      // Twice: the budget is no draft any more.
      expect(code(await f.submit(s.accountant, budget.id).expect(409))).toBe(
        'BUDGET_NOT_DRAFT',
      );
      // The board reads the budget with the package.
      const seen = await f
        .http('get', `/board/approvals/${requestId}`, o(0).token)
        .expect(200);
      expect((seen.body as { subject: unknown }).subject).toMatchObject({
        budgetId: budget.id,
        total: '600000.00',
        lines: [
          { category: 'security', amount: '480000.00', note: 'Two shifts' },
          { category: 'landscaping', amount: '120000.00', note: null },
        ],
      });
    });

    it('approved: active, implemented by the decision, and the board’s announcement to the owners', async () => {
      await f.approve(board(), requestId);
      expect((await f.budgetView(s.accountant, budget.id)).status).toBe(
        'active',
      );
      expect(
        (await f.staffView(s.accountant, requestId)).implementation,
      ).toEqual({
        implementedAt: expect.any(String) as string,
        byDecision: true,
        note: null,
      });
      const publication = await f.inTx(s.c, (tx) =>
        tx.boardPublication.findFirstOrThrow({
          where: { kind: 'decision' },
          orderBy: { createdAt: 'desc' },
        }),
      );
      expect(publication).toMatchObject({
        termId: s.term.id,
        authorSide: 'board',
        publishedById: o(1).id,
      });
      const announcement = await f
        .http('get', `/announcements/${publication.announcementId}`, o(4).token)
        .expect(200);
      expect(JSON.stringify(announcement.body)).toContain('600000.00');
      // Active: no other budget for the year.
      expect(
        code(
          await f
            .http('post', '/staff/finance/budgets', s.accountant.token, {
              fiscalYear: f.thisYear(),
            })
            .expect(409),
        ),
      ).toBe('BUDGET_YEAR_ACTIVE');
    });

    it('a budget_increase on one of its lines: approved, the line allows more', async () => {
      const line = (await f.budgetView(s.accountant, budget.id)).lines[0];
      const r = await f.raise(s.accountant, {
        type: 'budget_increase',
        budgetLineId: line.id,
        cost: '20000.00',
      });
      expect(
        (
          await f
            .http('get', `/board/approvals/${r.id}`, o(0).token)
            .expect(200)
        ).body,
      ).toMatchObject({
        subject: { category: 'security', allowance: '480000.00' },
      });
      // One pending per line.
      const again = await f
        .http('post', '/staff/governance/approvals', s.accountant.token, {
          type: 'budget_increase',
          budgetLineId: line.id,
          cost: '5.00',
          context: 'c',
          impact: 'i',
        })
        .expect(409);
      expect(again.body).toMatchObject({
        code: 'DUPLICATE_RESOURCE',
        fields: [{ field: 'budgetLineId', code: 'DUPLICATE_VALUE' }],
      });
      await f.approve(board(), r.id);
      const after = (await f.budgetView(s.accountant, budget.id)).lines[0];
      expect(after).toMatchObject({
        amount: '480000.00',
        increases: '20000.00',
        allowance: '500000.00',
      });
      expect(
        (await f.staffView(s.accountant, r.id)).implementation,
      ).toMatchObject({
        byDecision: true,
      });
    });
  });

  describe('rejected and withdrawn budgets are final', () => {
    it('next year’s draft, rejected: final, another is drafted from its lines', async () => {
      const d = await f.draft(s.accountant, { fiscalYear: f.thisYear() + 1 });
      await f
        .setLines(s.accountant, d.id, [
          { category: 'cleaning', amount: '9000.00' },
        ])
        .expect(200);
      const r = idOf(await f.submit(s.accountant, d.id).expect(201));
      const m = await f.motion(o(0), r, {
        outcome: 'reject',
        rationale: 'Too little for cleaning.',
      });
      await f.vote(o(0), m.id, 'for').expect(201);
      await f.vote(o(1), m.id, 'for').expect(201);
      expect((await f.budgetView(s.accountant, d.id)).status).toBe('rejected');
      const again = await f.draft(s.accountant, {
        fiscalYear: f.thisYear() + 1,
        copyFromId: d.id,
      });
      expect(again.lines.map((l) => [l.category, l.amount])).toEqual([
        ['cleaning', '9000.00'],
      ]);
      // Withdrawn with its request: final too.
      const r2 = idOf(await f.submit(s.accountant, again.id).expect(201));
      await f
        .http(
          'post',
          `/staff/governance/approvals/${r2}/withdraw`,
          s.accountant.token,
          {
            reasonCode: 'superseded',
          },
        )
        .expect(200);
      expect((await f.budgetView(s.accountant, again.id)).status).toBe(
        'withdrawn',
      );
    });

    it('an empty draft is not put to the board', async () => {
      const d = await f.draft(s.accountant, { fiscalYear: f.thisYear() - 1 });
      expect(code(await f.submit(s.accountant, d.id).expect(409))).toBe(
        'BUDGET_EMPTY',
      );
    });

    it('a year outside the one under way, the one before and the next is refused', async () => {
      const res = await f
        .http('post', '/staff/finance/budgets', s.accountant.token, {
          fiscalYear: f.thisYear() + 2,
        })
        .expect(400);
      expect((res.body as { fields: unknown[] }).fields).toEqual([
        {
          field: 'fiscalYear',
          code: 'INVALID_NUMBER',
          params: { min: f.thisYear() - 1, max: f.thisYear() + 1 },
        },
      ]);
    });
  });

  it('the fiscal year’s month changes until a budget exists', async () => {
    const other = await f.setUp(3, 3);
    await f
      .http('patch', '/staff/finance/budget-settings', other.accountant.token, {
        fiscalYearStartMonth: 7,
      })
      .expect(200);
    const d = await f.draft(other.accountant, { fiscalYear: f.thisYear(7) });
    expect(d.startsOn).toBe(`${f.thisYear(7)}-07-01`);
    expect(d.endsOn).toBe(`${f.thisYear(7) + 1}-06-30`);
    expect(
      code(
        await f
          .http(
            'patch',
            '/staff/finance/budget-settings',
            other.accountant.token,
            {
              fiscalYearStartMonth: 1,
            },
          )
          .expect(409),
      ),
    ).toBe('FISCAL_YEAR_LOCKED');
  });
});
