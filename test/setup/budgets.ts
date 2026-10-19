import type { Response } from 'supertest';
import type { Compound } from './community';
import { clock } from './compound-clock';
import { fileHelpers } from './files';
import { boardMatterHelpers, type Who } from './board-matters';
import type { HttpHarness } from './http-app';

export interface BudgetBody {
  id: string;
  fiscalYear: number;
  startsOn: string;
  endsOn: string;
  status: string;
  approvalRequestId: string | null;
  lines: {
    id: string;
    category: string;
    amount: string;
    increases: string;
    allowance: string;
    spent: string;
    remaining: string;
  }[];
  totals: Record<
    'budgeted' | 'increases' | 'allowance' | 'spent' | 'remaining',
    string
  >;
}

export interface ExpenseBody {
  id: string;
  number: string;
  amount: string;
  budgetLineId: string;
  authorizationId: string | null;
  voided: { reasonCode: string } | null;
}

/**
 * Helpers for the budget and expenses (ADR 0055) over HTTP, on top of the
 * board's: a draft, its lines, submitted to the board and approved by a
 * board of three (the first two members voting for).
 */
export function budgetHelpers(h: HttpHarness) {
  const b = boardMatterHelpers(h);
  const files = fileHelpers(h);
  const { http } = b;

  /** The fiscal year under way, as the compound counts it (January by default). */
  const thisYear = (startMonth = 1) => {
    const today = clock().today;
    const y = Number(today.slice(0, 4));
    return Number(today.slice(5, 7)) >= startMonth ? y : y - 1;
  };

  async function draft(
    by: Who,
    over: Record<string, unknown> = {},
  ): Promise<BudgetBody> {
    const res = await http('post', '/staff/finance/budgets', by.token, {
      fiscalYear: thisYear(),
      ...over,
    });
    if (res.status !== 201)
      throw new Error(`draft: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as BudgetBody;
  }

  const setLines = (
    by: Who,
    id: string,
    lines: { category: string; amount: string; note?: string }[],
  ) => http('put', `/staff/finance/budgets/${id}/lines`, by.token, { lines });

  const submit = (by: Who, budgetId: string) =>
    http('post', '/staff/governance/approvals', by.token, {
      type: 'annual_budget',
      budgetId,
      context: 'The budget for the year',
      impact: 'What the compound spends',
    });

  /** The board's two votes for, on a fresh motion of `members[0]`. */
  async function approve(members: Who[], requestId: string) {
    const m = await b.motion(members[0], requestId);
    await b.vote(members[0], m.id, 'for').expect(201);
    await b.vote(members[1], m.id, 'for').expect(201);
    return m;
  }

  /** A budget active for this year with `lines`; its view. */
  async function activeBudget(
    by: Who,
    members: Who[],
    lines: { category: string; amount: string }[],
  ): Promise<BudgetBody> {
    const d = await draft(by);
    await setLines(by, d.id, lines).expect(200);
    const r = await submit(by, d.id).expect(201);
    await approve(members, (r.body as { id: string }).id);
    return (
      await http('get', `/staff/finance/budgets/${d.id}`, by.token).expect(200)
    ).body as BudgetBody;
  }

  const invoice = (by: Who, contentType = 'application/pdf') =>
    files.ready(by.token, 'expense_invoice', contentType);

  async function expense(
    by: Who,
    lineId: string,
    amount: string,
    over: Record<string, unknown> = {},
  ): Promise<Response> {
    return http('post', '/staff/finance/expenses', by.token, {
      budgetLineId: lineId,
      vendor: 'Green Gardens Co.',
      amount,
      spentOn: clock().today,
      invoiceFileId: await invoice(by),
      ...over,
    });
  }

  const budgetView = async (by: Who, id: string): Promise<BudgetBody> =>
    (await http('get', `/staff/finance/budgets/${id}`, by.token).expect(200))
      .body as BudgetBody;

  return {
    ...b,
    files,
    thisYear,
    draft,
    setLines,
    submit,
    approve,
    activeBudget,
    invoice,
    expense,
    budgetView,
  };
}

export type { Compound, Who };
