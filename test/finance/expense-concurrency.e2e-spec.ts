import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const ROUNDS = 5;

/**
 * ADR 0055, the races of a budget line. An expense decides under the
 * line's row (its budget shared), so:
 * - two expenses that each fit what the line has left, but not together:
 *   one is recorded, the other refused with what is left after it;
 * - an expense and an approved increase of its line at once: the expense
 *   sees the line before or after the increase, never between;
 * - an expense and the void of another: the void's money is there or not,
 *   never counted twice.
 */
describe('Finance — a budget line, concurrently (ADR 0055)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let budget: BudgetBody;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    s = await f.setUp(4, 3);
    const lines = Array.from({ length: 3 }, (_, i) => ({
      category: ['security', 'cleaning', 'utilities'][i],
      amount: '1000.00',
    }));
    budget = await f.activeBudget(
      s.accountant,
      [s.owners[0], s.owners[1]],
      lines,
    );
  }, 240_000);

  afterAll(() => h.close());

  const spent = async (lineId: string) =>
    f.inTx(s.c, async (tx) => {
      const sum = await tx.financeExpense.aggregate({
        where: { budgetLineId: lineId, voidedAt: null },
        _sum: { amount: true },
      });
      return Number(sum._sum.amount ?? 0);
    });

  /** Voids every live expense of the line: it has its allowance again. */
  const voidAll = async (lineId: string) => {
    const live = await f.inTx(s.c, (tx) =>
      tx.financeExpense.findMany({
        where: { budgetLineId: lineId, voidedAt: null },
      }),
    );
    for (const e of live)
      await f
        .http(
          'post',
          `/staff/finance/expenses/${e.id}/void`,
          s.accountant.token,
          {
            reasonCode: 'other',
          },
        )
        .expect(200);
  };

  it('two expenses that fit alone but not together: one is recorded', async () => {
    const lineId = budget.lines.find((l) => l.category === 'security')!.id;
    for (let round = 0; round < ROUNDS; round++) {
      // 200 left: two of 101 each fit, not both.
      expect((await f.expense(s.accountant, lineId, '800.00')).status).toBe(
        201,
      );
      const [one, two] = await Promise.all([
        f.expense(s.accountant, lineId, '101.00'),
        f.expense(s.accountant, lineId, '101.00'),
      ]);
      expect([one.status, two.status].sort()).toEqual([201, 409]);
      expect([one, two].find((r) => r.status === 409)!.body).toMatchObject({
        code: 'EXPENSE_OVER_BUDGET',
        params: { remaining: '99.00' },
      });
      expect(await spent(lineId)).toBe(901);
      await voidAll(lineId);
    }
  });

  it('an expense while the line is increased: it fits only after the increase, and never past it', async () => {
    const lineId = budget.lines.find((l) => l.category === 'cleaning')!.id;
    for (let round = 0; round < ROUNDS; round++) {
      const before = await spent(lineId);
      const view = await f.budgetView(s.accountant, budget.id);
      const allowance = Number(
        view.lines.find((l) => l.id === lineId)!.allowance,
      );
      const r = await f.raise(s.accountant, {
        type: 'budget_increase',
        budgetLineId: lineId,
        cost: '100.00',
      });
      const m = await f.motion(s.owners[0], r.id);
      await f.vote(s.owners[0], m.id, 'for').expect(201);
      // What is left now, plus half the increase: fits only after it.
      const amount = (allowance - before + 50).toFixed(2);
      const [voted, recorded] = await Promise.all([
        f.vote(s.owners[1], m.id, 'for'),
        f.expense(s.accountant, lineId, amount),
      ]);
      expect(voted.status).toBe(201);
      expect([201, 409]).toContain(recorded.status);
      const after = await spent(lineId);
      expect(after).toBeLessThanOrEqual(allowance + 100);
      if (recorded.status === 409)
        expect((recorded.body as { code: string }).code).toBe(
          'EXPENSE_OVER_BUDGET',
        );
      else expect(after).toBeCloseTo(before + Number(amount), 2);
    }
  });

  it('an expense while another is voided: the voided money counts once', async () => {
    const lineId = budget.lines.find((l) => l.category === 'utilities')!.id;
    for (let round = 0; round < ROUNDS; round++) {
      const left = 1000 - (await spent(lineId));
      const first = await f.expense(s.accountant, lineId, left.toFixed(2));
      expect(first.status).toBe(201);
      const firstId = (first.body as { id: string }).id;
      const [voided, recorded] = await Promise.all([
        f.http(
          'post',
          `/staff/finance/expenses/${firstId}/void`,
          s.accountant.token,
          { reasonCode: 'entered_in_error' },
        ),
        f.expense(s.accountant, lineId, left.toFixed(2)),
      ]);
      expect(voided.status).toBe(200);
      expect([201, 409]).toContain(recorded.status);
      expect(await spent(lineId)).toBeLessThanOrEqual(1000);
      if (recorded.status === 201)
        expect(await spent(lineId)).toBeCloseTo(1000, 2);
      else {
        // Refused before the void committed: spend it again for the next round.
        expect(
          (await f.expense(s.accountant, lineId, left.toFixed(2))).status,
        ).toBe(201);
      }
      // Free the line for the next round.
      const live = await f.inTx(s.c, (tx) =>
        tx.financeExpense.findFirstOrThrow({
          where: { budgetLineId: lineId, voidedAt: null },
          orderBy: { recordedAt: 'desc' },
        }),
      );
      await f
        .http(
          'post',
          `/staff/finance/expenses/${live.id}/void`,
          s.accountant.token,
          { reasonCode: 'other' },
        )
        .expect(200);
    }
  });
});
