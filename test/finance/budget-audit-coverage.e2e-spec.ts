import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import * as split from '../setup/audit-coverage-split';
import { BUDGET_COVERAGE } from '../setup/audit-coverage-split';
import { budgetHelpers, type ExpenseBody } from '../setup/budgets';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per budget and expense catalog entry (ADR 0014, 0055): ids,
 * codes, amounts and days by value; a line's note, a vendor and a
 * reference as changed.
 */
const covered = new Set<string>();

describe('Audit coverage — the budget and expenses (ADR 0055)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    s = await f.setUp(4, 3);
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    expect(found).toHaveLength(1);
    return found[0];
  }
  const board = () => [s.owners[0], s.owners[1]];
  const idOf = (res: { body: unknown }) => (res.body as { id: string }).id;

  it('the fiscal year’s month', async () => {
    await f
      .http('patch', '/staff/finance/budget-settings', s.accountant.token, {
        fiscalYearStartMonth: 2,
      })
      .expect(200);
    const a = await single('budget.settings_changed', s.c.tenantId);
    expect(a.changes).toEqual({ fiscalYearStartMonth: { from: 1, to: 2 } });
    await f
      .http('patch', '/staff/finance/budget-settings', s.accountant.token, {
        fiscalYearStartMonth: 1,
      })
      .expect(200);
  });

  it('drafted, lines replaced, submitted, decided; an increase; the notes as changed', async () => {
    const d = await f.draft(s.accountant);
    expect((await single('budget.drafted', d.id)).metadata).toEqual({
      fiscalYear: d.fiscalYear,
      startsOn: d.startsOn,
      endsOn: d.endsOn,
      copiedFrom: null,
    });
    await f
      .setLines(s.accountant, d.id, [
        { category: 'security', amount: '900.00', note: 'AUDIT-NOTE' },
      ])
      .expect(200);
    const lines = await single('budget.lines_replaced', d.id);
    expect(lines.changes).toEqual({
      lines: { from: 0, to: 1 },
      total: { from: '0.00', to: '900.00' },
      notes: { changed: true },
    });
    const r = idOf(await f.submit(s.accountant, d.id).expect(201));
    expect((await single('budget.submitted', d.id)).metadata).toEqual({
      requestId: r,
      total: '900.00',
    });
    await f.approve(board(), r);
    expect((await single('budget.decided', d.id)).metadata).toEqual({
      requestId: r,
      status: 'active',
    });
    const lineId = (await f.budgetView(s.accountant, d.id)).lines[0].id;
    const inc = await f.raise(s.accountant, {
      type: 'budget_increase',
      budgetLineId: lineId,
      cost: '100.00',
    });
    await f.approve(board(), inc.id);
    expect((await single('budget_line.increased', lineId)).metadata).toEqual({
      budgetId: d.id,
      requestId: inc.id,
      amount: '100.00',
    });

    const res = await f.expense(s.accountant, lineId, '50.00', {
      vendor: 'AUDIT-VENDOR',
      reference: 'AUDIT-REF',
    });
    const e = res.body as ExpenseBody;
    const recorded = await single('expense.recorded', e.id);
    expect(recorded.changes).toMatchObject({
      lineId: { from: null, to: lineId },
      amount: { from: null, to: '50.00' },
      vendor: { changed: true },
      reference: { changed: true },
    });
    expect(JSON.stringify(recorded)).not.toContain('AUDIT-');
    await f
      .http(
        'post',
        `/staff/finance/expenses/${e.id}/void`,
        s.accountant.token,
        {
          reasonCode: 'vendor_refund',
        },
      )
      .expect(200);
    expect((await single('expense.voided', e.id)).metadata).toEqual({
      reasonCode: 'vendor_refund',
    });
  });

  it('withdrawn with its request; an approved contract’s authorization', async () => {
    const d = await f.draft(s.accountant, { fiscalYear: f.thisYear() + 1 });
    await f
      .setLines(s.accountant, d.id, [{ category: 'other', amount: '1.00' }])
      .expect(200);
    const r = idOf(await f.submit(s.accountant, d.id).expect(201));
    await f
      .http(
        'post',
        `/staff/governance/approvals/${r}/withdraw`,
        s.accountant.token,
        {
          reasonCode: 'superseded',
        },
      )
      .expect(200);
    expect((await single('budget.withdrawn', d.id)).metadata).toEqual({
      requestId: r,
    });
    const contract = await f.raise(s.manager, {
      type: 'major_contract',
      cost: '7000.00',
    });
    await f.approve(board(), contract.id);
    const auth = await f.inTx(s.c, (tx) =>
      tx.financeExpenseAuthorization.findFirstOrThrow({
        where: { approvalRequestId: contract.id },
      }),
    );
    expect(
      (await single('expense_authorization.granted', auth.id)).metadata,
    ).toEqual({ requestId: contract.id, amount: '7000.00' });
  });

  describe('catalog completeness', () => {
    it('every budget entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      const others = Object.entries(split)
        .filter(([name]) => name !== 'BUDGET_COVERAGE')
        .flatMap(([, list]) => list);
      for (const key of BUDGET_COVERAGE) {
        expect(all).toContain(key);
        expect(others).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...BUDGET_COVERAGE].sort());
      expect(
        all
          .filter((k) =>
            /^(budget|budget_line|expense|expense_authorization)\./.test(k),
          )
          .sort(),
      ).toEqual([...BUDGET_COVERAGE].sort());
    });
  });
});
