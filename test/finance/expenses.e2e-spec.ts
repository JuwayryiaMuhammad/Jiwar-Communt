import {
  budgetHelpers,
  type BudgetBody,
  type ExpenseBody,
} from '../setup/budgets';
import { clock } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0055, expenses: recorded against a line of the active budget, never
 * past what it has left (EXPENSE_OVER_BUDGET), and above the manager's
 * limit only by naming a major contract the board approved
 * (EXPENSE_NEEDS_APPROVAL), spent down by its expenses; voided once.
 */
describe('Finance — expenses (ADR 0055)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let budget: BudgetBody;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    s = await f.setUp(4, 3);
    budget = await f.activeBudget(
      s.accountant,
      [s.owners[0], s.owners[1]],
      [
        { category: 'maintenance', amount: '100000.00' },
        { category: 'utilities', amount: '5000.00' },
      ],
    );
  }, 240_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];
  const line = (category: string) =>
    budget.lines.find((l) => l.category === category)!;
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;

  it('recorded within the line: numbered, with its invoice; the line spends it', async () => {
    const res = await f.expense(s.accountant, line('utilities').id, '1200.00', {
      reference: 'BILL-77',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      number: expect.stringMatching(/^EX-\d{6}$/) as string,
      amount: '1200.00',
      category: 'utilities',
      reference: 'BILL-77',
      voided: null,
      invoiceUrl: expect.any(String) as string,
    });
    expect(
      (await f.budgetView(s.accountant, budget.id)).lines.find(
        (l) => l.category === 'utilities',
      ),
    ).toMatchObject({ spent: '1200.00', remaining: '3800.00' });
  });

  it('past what the line has left: EXPENSE_OVER_BUDGET with the remainder; a void gives it back', async () => {
    const over = await f
      .expense(s.accountant, line('utilities').id, '3800.01')
      .then((r) => r);
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({
      code: 'EXPENSE_OVER_BUDGET',
      params: { remaining: '3800.00' },
    });
    const all = await f.expense(s.accountant, line('utilities').id, '3800.00');
    expect(all.status).toBe(201);
    const voided = await f
      .http(
        'post',
        `/staff/finance/expenses/${(all.body as ExpenseBody).id}/void`,
        s.accountant.token,
        {
          reasonCode: 'duplicate',
        },
      )
      .expect(200);
    expect((voided.body as ExpenseBody).voided).toMatchObject({
      reasonCode: 'duplicate',
    });
    expect(
      code(
        await f
          .http(
            'post',
            `/staff/finance/expenses/${(all.body as ExpenseBody).id}/void`,
            s.accountant.token,
            {
              reasonCode: 'other',
            },
          )
          .expect(409),
      ),
    ).toBe('EXPENSE_ALREADY_VOIDED');
    expect(
      (await f.expense(s.accountant, line('utilities').id, '3800.00')).status,
    ).toBe(201);
  });

  it('above the manager’s limit: refused until the board approves a major contract, then spent down by it', async () => {
    await f
      .http('patch', '/staff/governance/settings', s.manager.token, {
        items: [{ type: 'major_contract', threshold: '10000.00' }],
      })
      .expect(200);
    const big = await f.expense(
      s.accountant,
      line('maintenance').id,
      '25000.00',
    );
    expect(big.status).toBe(409);
    expect(big.body).toMatchObject({
      code: 'EXPENSE_NEEDS_APPROVAL',
      params: { limit: '10000.00' },
    });
    // At the limit is the manager's own.
    expect(
      (await f.expense(s.accountant, line('maintenance').id, '10000.00'))
        .status,
    ).toBe(201);
    const contract = await f.raise(s.manager, {
      type: 'major_contract',
      cost: '40000.00',
      context: 'The pumps’ overhaul',
    });
    await f.approve([o(0), o(1)], contract.id);
    const [auth] = (
      await f
        .http(
          'get',
          '/staff/finance/expense-authorizations',
          s.accountant.token,
        )
        .expect(200)
    ).body as { id: string; remaining: string }[];
    expect(auth.remaining).toBe('40000.00');
    expect(
      (
        await f.expense(s.accountant, line('maintenance').id, '25000.00', {
          authorizationId: auth.id,
        })
      ).status,
    ).toBe(201);
    const exceeded = await f.expense(
      s.accountant,
      line('maintenance').id,
      '15000.01',
      {
        authorizationId: auth.id,
      },
    );
    expect(exceeded.body).toMatchObject({
      code: 'EXPENSE_AUTHORIZATION_EXCEEDED',
      params: { remaining: '15000.00' },
    });
    // The contract itself waits for the manager to mark it.
    expect(
      (await f.staffView(s.manager, contract.id)).implementation,
    ).toBeNull();
  });

  it('the day: within the budget’s year and not ahead', async () => {
    const ahead = await f.expense(
      s.accountant,
      line('maintenance').id,
      '1.00',
      {
        spentOn: clock().day(1),
      },
    );
    expect(ahead.status).toBe(400);
    expect(
      (ahead.body as { fields: { field: string; code: string }[] }).fields,
    ).toEqual([
      {
        field: 'spentOn',
        code: 'DAY_OUT_OF_RANGE',
        params: { min: budget.startsOn, max: clock().today },
      },
    ]);
  });

  it('an invoice of the caller’s own, of its purpose, once', async () => {
    const other = await f.invoice(s.manager);
    const res = await f.expense(s.accountant, line('maintenance').id, '1.00', {
      invoiceFileId: other,
    });
    expect((res.body as { fields: unknown[] }).fields).toEqual([
      { field: 'invoiceFileId', code: 'FILE_NOT_AVAILABLE' },
    ]);
  });

  it('only on the active budget; only who keeps the budget records', async () => {
    const next = await f.draft(s.accountant, { fiscalYear: f.thisYear() + 1 });
    await f
      .setLines(s.accountant, next.id, [{ category: 'other', amount: '10.00' }])
      .expect(200);
    const draftLine = (await f.budgetView(s.accountant, next.id)).lines[0];
    expect(code(await f.expense(s.accountant, draftLine.id, '1.00'))).toBe(
      'BUDGET_NOT_ACTIVE',
    );
    await f
      .http('post', '/staff/finance/expenses', o(0).token, {
        budgetLineId: line('maintenance').id,
        vendor: 'v',
        amount: '1.00',
        spentOn: clock().today,
        invoiceFileId: line('maintenance').id,
      })
      .expect(403);
  });
});
