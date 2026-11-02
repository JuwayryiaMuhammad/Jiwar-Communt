import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { GUARANTEE_SWEEP } from '../../src/finance/payables/guarantee-sweep';
import { err } from '../api/request';
import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { clock, day } from '../setup/compound-clock';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { deferred } from '../setup/permits';
import { addDays } from '../../src/core/common/slots/day-slots';

interface Line {
  id: string;
  category: string;
  allowance: string;
  spent: string;
  committed: string;
  payable: string;
  available: string;
  transfersIn: string;
  transfersOut: string;
}
interface Invoice {
  id: string;
  number: string;
  status: string;
  total: string;
  tax: string;
  budgetLineId: string | null;
  authorizationId: string | null;
  payout: {
    id: string;
    number: string;
    cashAccountId: string | null;
    gross: string;
    retentionHeld: string;
    advanceSetOff: string;
    net: string;
    expenseId: string;
  } | null;
}
interface Commitment {
  id: string;
  contractPaymentId: string | null;
  purchaseRequestId: string | null;
  amount: string;
  open: string;
  closedAt: string | null;
}

/**
 * ADR 0089: vendors' invoices approved against the budget line and paid
 * once into their expense; commitments a contract's payments and an
 * approved purchase keep; transfers between lines; a line's months and its
 * variances; advances, retentions and guarantees; the payment schedule and
 * the entries export.
 */
describe('Payables and commitments (ADR 0089)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let budget: BudgetBody;
  /** The bank account payouts leave (ADR 0085). */
  let bank: { id: string };

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    s = await f.setUp(4, 3);
    budget = await f.activeBudget(
      s.accountant,
      [s.owners[0], s.owners[1]],
      [
        { category: 'maintenance', amount: '500000.00' },
        { category: 'cleaning', amount: '120000.00' },
      ],
    );
    await setThreshold('100000.00');
    bank = (
      await f
        .http('post', '/staff/finance/cash-accounts', s.manager.token, {
          kind: 'bank',
          name: 'Payables bank',
          openedOn: clock().today,
        })
        .expect(201)
    ).body as { id: string };
  }, 240_000);

  afterAll(() => h.close());

  const http = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    token: string,
    body?: object,
  ) => f.http(method, path, token, body);
  const m = () => s.manager.token;
  const acc = () => s.accountant.token;
  const maintenance = () =>
    budget.lines.find((l) => l.category === 'maintenance')!;
  const cleaning = () => budget.lines.find((l) => l.category === 'cleaning')!;
  const today = () => clock().today;
  /** A day of the budget's year, `n` days after its start. */
  const yearDay = (n: number) => addDays(budget.startsOn, n);
  const setThreshold = (threshold: string | null) =>
    http('patch', '/staff/governance/settings', m(), {
      items: [{ type: 'major_contract', threshold }],
    }).expect(200);
  const lineOf = async (id: string): Promise<Line> =>
    (await f.budgetView(s.accountant, budget.id)).lines.find(
      (l) => l.id === id,
    ) as unknown as Line;

  const vendor = async () =>
    (
      (
        await http('post', '/staff/vendors', m(), {
          name: `Payee ${uniqueSuffix()}`,
          categories: ['maintenance'],
        }).expect(201)
      ).body as { id: string }
    ).id;
  /** A contract on a line, over the budget's year and a little after. */
  const contract = async (over: object = {}) =>
    (
      await http('post', '/maintenance/contracts', m(), {
        code: `PC-${uniqueSuffix()}`,
        kind: 'amc',
        vendorId: await vendor(),
        startsOn: budget.startsOn,
        endsOn: addDays(budget.endsOn, 60),
        annualValue: '60000.00',
        budgetLineId: maintenance().id,
        ...over,
      }).expect(201)
    ).body as { id: string; vendorId: string };
  const schedule = async (
    contractId: string,
    payments: { dueOn: string; amount: string }[],
  ) =>
    (
      (
        await http(
          'put',
          `/maintenance/contracts/${contractId}/payments`,
          m(),
          { payments },
        ).expect(200)
      ).body as { data: { id: string; dueOn: string; amount: string }[] }
    ).data;
  const commitmentsOf = async (q: string) =>
    (
      (await http('get', `/staff/finance/commitments?${q}`, acc()).expect(200))
        .body as { data: Commitment[] }
    ).data;
  const record = (body: object, by = acc()) =>
    deferred(
      (async () =>
        http('post', '/staff/finance/vendor-invoices', by, {
          vendorNumber: `INV-${uniqueSuffix()}`,
          issuedOn: today(),
          dueOn: day(10),
          invoiceFileId: await f.invoice(by === m() ? s.manager : s.accountant),
          lines: [{ description: 'Monthly service', amount: '5000.00' }],
          ...body,
        }))(),
    );
  const approve = (id: string, body: object = {}) =>
    http('post', `/staff/finance/vendor-invoices/${id}/approve`, m(), body);
  const pay = (id: string, body: object = {}) =>
    http('post', `/staff/finance/vendor-invoices/${id}/pay`, acc(), {
      paidOn: today(),
      method: 'bank_transfer',
      reference: 'TRF-1',
      cashAccountId: bank.id,
      ...body,
    });

  describe('commitments', () => {
    it('a contract’s unpaid payments in its line’s year keep the line, follow the schedule and are given back at its end', async () => {
      const before = await lineOf(maintenance().id);
      const c = await contract();
      const pays = await schedule(c.id, [
        { dueOn: yearDay(10), amount: '1000.00' },
        { dueOn: yearDay(40), amount: '2000.00' },
        // After the budget's year: not this line's.
        { dueOn: addDays(budget.endsOn, 30), amount: '9000.00' },
      ]);
      expect(pays).toHaveLength(3);
      let open = await commitmentsOf(`open=true&source=contract`);
      const mine = () =>
        open.filter((x) => pays.some((p) => p.id === x.contractPaymentId));
      expect(
        mine()
          .map((x) => x.amount)
          .sort(),
      ).toEqual(['1000.00', '2000.00']);
      const after = await lineOf(maintenance().id);
      expect(Number(after.committed) - Number(before.committed)).toBe(3000);
      expect(Number(before.available) - Number(after.available)).toBe(3000);
      // A changed amount is released and reserved afresh.
      const again = await schedule(c.id, [
        { dueOn: yearDay(10), amount: '1500.00' },
        { dueOn: yearDay(40), amount: '2000.00' },
      ]);
      open = await commitmentsOf(`open=true&source=contract`);
      expect(
        open
          .filter((x) => again.some((p) => p.id === x.contractPaymentId))
          .map((x) => x.amount)
          .sort(),
      ).toEqual(['1500.00', '2000.00']);
      await http('post', `/maintenance/contracts/${c.id}/terminate`, m(), {
        reasonCode: 'not_needed',
      }).expect(200);
      open = await commitmentsOf(`open=true&source=contract`);
      expect(
        open.filter((x) => again.some((p) => p.id === x.contractPaymentId)),
      ).toEqual([]);
      expect((await lineOf(maintenance().id)).committed).toBe(before.committed);
    });

    it('a schedule the line cannot keep is refused whole', async () => {
      const c = await contract({ budgetLineId: cleaning().id });
      const res = await http(
        'put',
        `/maintenance/contracts/${c.id}/payments`,
        m(),
        { payments: [{ dueOn: yearDay(20), amount: '900000.00' }] },
      ).expect(409);
      expect(err(res)).toMatchObject({ code: 'BUDGET_LINE_INSUFFICIENT' });
      const kept = await http(
        'get',
        `/maintenance/contracts/${c.id}/payments`,
        m(),
      ).expect(200);
      expect((kept.body as { data: unknown[] }).data).toEqual([]);
    });

    it('an approved purchase keeps its estimate until called off; an expense spends only what is available', async () => {
      const line = await lineOf(cleaning().id);
      const pr = (
        await http('post', '/staff/purchase-requests', acc(), {
          title: 'Floor polish',
          estimatedAmount: '4000',
          budgetLineId: cleaning().id,
        }).expect(201)
      ).body as { id: string };
      await http(
        'post',
        `/staff/purchase-requests/${pr.id}/approve`,
        m(),
        {},
      ).expect(200);
      const held = await lineOf(cleaning().id);
      expect(Number(held.committed) - Number(line.committed)).toBe(4000);
      const res = await deferred(
        f.expense(
          s.accountant,
          cleaning().id,
          String(Number(held.available) + 1),
        ),
      ).expect(409);
      expect(err(res)).toMatchObject({
        code: 'EXPENSE_OVER_BUDGET',
        params: { remaining: held.available },
      });
      await http('post', `/staff/purchase-requests/${pr.id}/cancel`, m(), {
        reasonCode: 'not_needed',
      }).expect(200);
      expect((await lineOf(cleaning().id)).committed).toBe(line.committed);
    });
  });

  describe('vendors’ invoices', () => {
    it('recorded once per vendor’s number whatever its case, approved by another, released from its commitment, paid once into its expense', async () => {
      const c = await contract({ retentionPct: '5' });
      const [p] = await schedule(c.id, [
        { dueOn: yearDay(15), amount: '5000.00' },
      ]);
      const vendorNumber = `Q-${uniqueSuffix()}`;
      const made = await record({
        contractId: c.id,
        contractPaymentId: p.id,
        vendorNumber,
      }).expect(201);
      const inv = made.body as Invoice;
      expect(inv).toMatchObject({
        status: 'received',
        total: '5000.00',
        budgetLineId: maintenance().id,
      });
      expect(inv.number).toMatch(/^VI-\d{6,}$/);
      expect(
        await f.inTx(s.c, (tx) =>
          tx.notification.count({
            where: {
              accountId: s.manager.id,
              kind: 'vendor_invoice.received',
              targetId: inv.id,
            },
          }),
        ),
      ).toBe(1);
      expect(
        err(
          await record({
            contractId: c.id,
            vendorNumber: vendorNumber.toLowerCase(),
          }).expect(409),
        ),
      ).toMatchObject({
        code: 'VENDOR_INVOICE_DUPLICATE',
        params: { invoiceId: inv.id },
      });
      // A payment an invoice names stays as it is.
      expect(
        err(
          await http(
            'post',
            `/maintenance/contracts/${c.id}/payments/${p.id}/pay`,
            m(),
            { paidOn: today() },
          ).expect(409),
        ),
      ).toMatchObject({ code: 'CONTRACT_PAYMENT_INVOICED' });
      expect(
        err(
          await http('put', `/maintenance/contracts/${c.id}/payments`, m(), {
            payments: [],
          }).expect(409),
        ),
      ).toMatchObject({ code: 'CONTRACT_PAYMENT_INVOICED' });
      const before = await lineOf(maintenance().id);
      const ok = (await approve(inv.id).expect(200)).body as Invoice;
      expect(ok.status).toBe('approved');
      const after = await lineOf(maintenance().id);
      expect(Number(before.committed) - Number(after.committed)).toBe(5000);
      expect(Number(after.payable) - Number(before.payable)).toBe(5000);
      expect(after.available).toBe(before.available);
      expect(err(await approve(inv.id).expect(409))).toMatchObject({
        code: 'VENDOR_INVOICE_STATE',
      });
      const paid = (await pay(inv.id).expect(200)).body as Invoice;
      expect(paid.status).toBe('paid');
      expect(paid.payout).toMatchObject({
        gross: '5000.00',
        retentionHeld: '250.00',
        advanceSetOff: '0.00',
        net: '4750.00',
      });
      const spent = await lineOf(maintenance().id);
      expect(Number(spent.spent) - Number(after.spent)).toBe(5000);
      expect(spent.available).toBe(after.available);
      const expense = (
        await http(
          'get',
          `/staff/finance/expenses/${paid.payout!.expenseId}`,
          acc(),
        ).expect(200)
      ).body as { amount: string; reference: string };
      expect(expense).toMatchObject({
        amount: '5000.00',
        reference: paid.payout!.number,
      });
      expect(
        err(
          await http(
            'post',
            `/staff/finance/expenses/${paid.payout!.expenseId}/void`,
            acc(),
            { reasonCode: 'duplicate' },
          ).expect(409),
        ),
      ).toMatchObject({ code: 'EXPENSE_FROM_PAYOUT' });
      const payments = (
        await http(
          'get',
          `/maintenance/contracts/${c.id}/payments`,
          m(),
        ).expect(200)
      ).body as { data: { id: string; paidOn: string | null }[] };
      expect(payments.data[0].paidOn).toBe(today());
      expect(err(await pay(inv.id).expect(409))).toMatchObject({
        code: 'VENDOR_INVOICE_STATE',
      });
      const position = (
        await http(
          'get',
          `/staff/finance/contract-payables/${c.id}`,
          acc(),
        ).expect(200)
      ).body as { retention: { held: string } };
      expect(position.retention.held).toBe('250.00');
    });

    it('who recorded it never approves it; a tax code taxes its line', async () => {
      const c = await contract();
      const inv = (
        await record(
          {
            contractId: c.id,
            lines: [
              { description: 'Parts', amount: '1000.00', taxCode: 'vat_14' },
              { description: 'Labour', amount: '500.00' },
            ],
          },
          m(),
        ).expect(201)
      ).body as Invoice;
      expect(inv).toMatchObject({ tax: '140.00', total: '1640.00' });
      expect(err(await approve(inv.id).expect(409))).toMatchObject({
        code: 'PAYABLE_SELF_APPROVAL',
      });
      await http(
        'post',
        `/staff/finance/vendor-invoices/${inv.id}/cancel`,
        m(),
        {
          reasonCode: 'entered_in_error',
        },
      ).expect(200);
    });

    it('above the manager’s limit it spends the board’s approval its contract was signed under', async () => {
      await setThreshold('1000.00');
      try {
        const r = await f.raise(s.manager, {
          type: 'major_contract',
          cost: '50000.00',
          context: 'The cleaning contract',
        });
        await f.approve([s.owners[0], s.owners[1]], r.id);
        const c = await contract({
          approvalRequestId: r.id,
          annualValue: '50000.00',
        });
        const inv = (
          await record({
            contractId: c.id,
            lines: [{ description: 'Quarter', amount: '12000.00' }],
          }).expect(201)
        ).body as Invoice;
        expect(inv.authorizationId).not.toBeNull();
        await approve(inv.id).expect(200);
        const auths = (
          await http(
            'get',
            '/staff/finance/expense-authorizations',
            acc(),
          ).expect(200)
        ).body as { id: string; remaining: string }[];
        expect(auths.find((a) => a.id === inv.authorizationId)?.remaining).toBe(
          '38000.00',
        );
        // One without the board's approval is refused.
        const bare = await contract({ annualValue: '900.00' });
        const big = (
          await record({
            contractId: bare.id,
            lines: [{ description: 'Overhaul', amount: '2000.00' }],
          }).expect(201)
        ).body as Invoice;
        expect(err(await approve(big.id).expect(409))).toMatchObject({
          code: 'EXPENSE_NEEDS_APPROVAL',
          params: { limit: '1000.00' },
        });
      } finally {
        await setThreshold('100000.00');
      }
    });

    it('against a purchase request only once it is fulfilled', async () => {
      const v = await vendor();
      const pr = (
        await http('post', '/staff/purchase-requests', acc(), {
          title: 'Pump seals',
          estimatedAmount: '3000',
          vendorId: v,
          budgetLineId: maintenance().id,
        }).expect(201)
      ).body as { id: string };
      await http(
        'post',
        `/staff/purchase-requests/${pr.id}/approve`,
        m(),
        {},
      ).expect(200);
      expect(
        err(await record({ purchaseRequestId: pr.id }).expect(409)),
      ).toMatchObject({
        code: 'VENDOR_INVOICE_SOURCE_INVALID',
        params: { reason: 'not_fulfilled' },
      });
      await http(
        'post',
        `/staff/purchase-requests/${pr.id}/fulfil`,
        m(),
        {},
      ).expect(200);
      const inv = (
        await record({
          purchaseRequestId: pr.id,
          lines: [{ description: 'Seals', amount: '2000.00' }],
        }).expect(201)
      ).body as Invoice;
      await approve(inv.id).expect(200);
      const [c] = (await commitmentsOf(`source=purchase_request`)).filter(
        (x) => x.purchaseRequestId === pr.id,
      );
      expect(c).toMatchObject({ amount: '3000.00', open: '1000.00' });
      const inbox = (
        await http('get', '/staff/inbox?type=vendor_invoice', m()).expect(200)
      ).body as { data: { id: string }[] };
      expect(inbox.data.some((x) => x.id === inv.id)).toBe(false);
    });

    it('the payment schedule shows what is approved and what is committed by day', async () => {
      const c = await contract();
      const [p] = await schedule(c.id, [
        { dueOn: yearDay(200), amount: '700.00' },
      ]);
      const inv = (
        await record({ contractId: c.id, dueOn: day(20) }).expect(201)
      ).body as Invoice;
      await approve(inv.id).expect(200);
      const sch = (
        await http(
          'get',
          `/staff/finance/payment-schedule?from=${budget.startsOn}&to=${budget.endsOn}`,
          acc(),
        ).expect(200)
      ).body as { rows: { kind: string; id: string; amount: string }[] };
      expect(
        sch.rows.some((r) => r.kind === 'invoice' && r.id === inv.id),
      ).toBe(day(20) <= budget.endsOn);
      const committed = (await commitmentsOf('open=true')).find(
        (x) => x.contractPaymentId === p.id,
      );
      expect(
        sch.rows.some((r) => r.kind === 'commitment' && r.id === committed?.id),
      ).toBe(true);
    });
  });

  describe('transfers, months and variances', () => {
    it('within the limit a transfer is applied at once; above it the board applies it', async () => {
      const from = await lineOf(maintenance().id);
      const to = await lineOf(cleaning().id);
      const t = (
        await http('post', '/staff/finance/budget-transfers', acc(), {
          fromLineId: maintenance().id,
          toLineId: cleaning().id,
          amount: '1000.00',
          reason: 'Extra cleaning after works',
        }).expect(201)
      ).body as { id: string; status: string };
      expect(t.status).toBe('applied');
      expect(
        Number((await lineOf(cleaning().id)).allowance) - Number(to.allowance),
      ).toBe(1000);
      expect(
        Number(from.allowance) -
          Number((await lineOf(maintenance().id)).allowance),
      ).toBe(1000);
      const big = (
        await http('post', '/staff/finance/budget-transfers', acc(), {
          fromLineId: maintenance().id,
          toLineId: cleaning().id,
          amount: '150000.00',
          reason: 'A new cleaning contract',
        }).expect(201)
      ).body as { id: string; status: string };
      expect(big.status).toBe('awaiting_board');
      const raised = await f.raise(s.accountant, {
        type: 'budget_transfer',
        budgetTransferId: big.id,
        cost: undefined,
        context: 'Move the money to cleaning',
      });
      expect(raised.cost).toBe('150000.00');
      expect(
        err(
          await http(
            'post',
            `/staff/finance/budget-transfers/${big.id}/cancel`,
            acc(),
          ).expect(409),
        ),
      ).toMatchObject({ code: 'BUDGET_TRANSFER_STATE' });
      await f.approve([s.owners[0], s.owners[1]], raised.id);
      const done = (
        await http(
          'get',
          `/staff/finance/budget-transfers/${big.id}`,
          acc(),
        ).expect(200)
      ).body as { status: string };
      expect(done.status).toBe('applied');
      expect(
        err(
          await http('post', '/staff/finance/budget-transfers', acc(), {
            fromLineId: cleaning().id,
            toLineId: maintenance().id,
            amount: '999999.00',
            reason: 'Too much',
          }).expect(409),
        ),
      ).toMatchObject({ code: 'BUDGET_LINE_INSUFFICIENT' });
    });

    it('a line split by quarter reads by month and quarter, and a variance past the setting asks for its reason', async () => {
      const b = await f.budgetView(s.accountant, budget.id);
      const line = b.lines.find((l) => l.category === 'maintenance')!;
      const bad = await http(
        'put',
        `/staff/finance/budgets/${budget.id}/months`,
        acc(),
        {
          lines: [{ lineId: line.id, quarters: ['1', '2', '3', '4'] }],
        },
      ).expect(400);
      expect(JSON.stringify(bad.body)).toContain('INVALID_VALUE');
      await http('put', `/staff/finance/budgets/${budget.id}/months`, acc(), {
        lines: [
          {
            lineId: line.id,
            quarters: ['200000.00', '100000.00', '100000.00', '100000.00'],
          },
        ],
      }).expect(200);
      await http('patch', '/staff/finance/variance-settings', acc(), {
        varianceReasonPct: 10,
      }).expect(200);
      const q = (
        await http(
          'get',
          `/staff/finance/reports/budget-periods?budgetId=${budget.id}&by=quarter`,
          acc(),
        ).expect(200)
      ).body as {
        lines: {
          lineId: string;
          periods: { planned: string; period: number }[];
        }[];
        varianceReasonPct: number;
      };
      expect(q.varianceReasonPct).toBe(10);
      const periods = q.lines.find((l) => l.lineId === line.id)!.periods;
      expect(periods).toHaveLength(4);
      expect((periods[0] as unknown as { from: string }).from).toBe(
        budget.startsOn,
      );
      await http(
        'post',
        `/staff/finance/budget-lines/${line.id}/variance-reasons`,
        acc(),
        {
          month: 1,
          reasonCode: 'timing',
          note: 'Paid ahead',
        },
      ).expect(204);
      const csv = await http(
        'get',
        `/staff/finance/reports/budget-periods/export?budgetId=${budget.id}`,
        acc(),
      ).expect(200);
      expect(csv.text).toContain('category,period,from,to,planned');
    });
  });

  describe('paid from the treasury’s accounts (ADR 0085)', () => {
    const balance = async (id: string) =>
      (
        (
          await http('get', `/staff/finance/cash-accounts/${id}`, m()).expect(
            200,
          )
        ).body as { balance: string }
      ).balance;

    it('what a payout pays leaves one account of its method’s kind as one movement; a cash box never goes below zero', async () => {
      const box = (
        await http('post', '/staff/finance/cash-accounts', m(), {
          kind: 'cash',
          name: `Payout box ${uniqueSuffix()}`,
          openingBalance: '1000.00',
          openedOn: today(),
        }).expect(201)
      ).body as { id: string };
      const inv = (await record({}).expect(201)).body as Invoice;
      await approve(inv.id).expect(200);
      expect(
        err(await pay(inv.id, { cashAccountId: undefined }).expect(400)).fields,
      ).toEqual([{ field: 'cashAccountId', code: 'FIELD_REQUIRED' }]);
      expect(
        err(await pay(inv.id, { method: 'cash' }).expect(409)),
      ).toMatchObject({
        code: 'CASH_ACCOUNT_WRONG_KIND',
        params: { kind: 'cash' },
      });
      expect(
        err(await pay(inv.id, { cashAccountId: box.id }).expect(409)),
      ).toMatchObject({
        code: 'CASH_ACCOUNT_WRONG_KIND',
        params: { kind: 'bank' },
      });
      expect(
        err(
          await pay(inv.id, { method: 'cash', cashAccountId: box.id }).expect(
            409,
          ),
        ),
      ).toMatchObject({
        code: 'CASH_ACCOUNT_INSUFFICIENT',
        params: { balance: '1000.00' },
      });
      expect(await balance(box.id)).toBe('1000.00');
      const before = Number(await balance(bank.id));
      const paid = (await pay(inv.id).expect(200)).body as Invoice;
      expect(paid.payout).toMatchObject({
        net: '5000.00',
        cashAccountId: bank.id,
      });
      expect(before - Number(await balance(bank.id))).toBe(5000);
      const moved = (
        (
          await http(
            'get',
            `/staff/finance/cash-movements?accountId=${bank.id}`,
            m(),
          ).expect(200)
        ).body as {
          data: {
            kind: string;
            amount: string;
            onDay: string;
            payoutId: string | null;
          }[];
        }
      ).data.filter((x) => x.kind === 'payout');
      expect(moved.filter((x) => x.payoutId === paid.payout!.id)).toEqual([
        expect.objectContaining({ amount: '-5000.00', onDay: today() }),
      ]);
    });
  });

  describe('advances, retentions and guarantees', () => {
    it('an advance asked by one and approved by another, paid, then set off against an invoice', async () => {
      const c = await contract();
      const adv = (
        await http(
          'post',
          `/staff/finance/contract-payables/${c.id}/disbursements`,
          acc(),
          {
            kind: 'advance',
            amount: '3000.00',
          },
        ).expect(201)
      ).body as { id: string; number: string };
      expect(adv.number).toMatch(/^VD-/);
      expect(
        err(
          await http(
            'post',
            `/staff/finance/contract-payables/${c.id}/disbursements`,
            acc(),
            { kind: 'advance', amount: '58000.00' },
          ).expect(409),
        ),
      ).toMatchObject({ code: 'ADVANCE_EXCEEDED' });
      await http(
        'post',
        `/staff/finance/contract-disbursements/${adv.id}/approve`,
        m(),
      ).expect(200);
      await http(
        'post',
        `/staff/finance/contract-disbursements/${adv.id}/pay`,
        acc(),
        {
          paidOn: today(),
          method: 'cheque',
          cashAccountId: bank.id,
        },
      ).expect(200);
      const inv = (await record({ contractId: c.id }).expect(201))
        .body as Invoice;
      await approve(inv.id).expect(200);
      expect(
        err(await pay(inv.id, { advanceSetOff: '3500.00' }).expect(409)),
      ).toMatchObject({
        code: 'ADVANCE_SET_OFF_EXCEEDED',
        params: { open: '3000.00' },
      });
      const paid = (await pay(inv.id, { advanceSetOff: '3000.00' }).expect(200))
        .body as Invoice;
      expect(paid.payout).toMatchObject({
        advanceSetOff: '3000.00',
        net: '2000.00',
      });
      const pos = (
        await http(
          'get',
          `/staff/finance/contract-payables/${c.id}`,
          acc(),
        ).expect(200)
      ).body as { advances: { open: string } };
      expect(pos.advances.open).toBe('0.00');
    });

    it('a retention is released only at the contract’s end, within what is held, never by who asked', async () => {
      const c = await contract({ retentionPct: '10' });
      const inv = (await record({ contractId: c.id }).expect(201))
        .body as Invoice;
      await approve(inv.id).expect(200);
      await pay(inv.id).expect(200);
      expect(
        err(
          await http(
            'post',
            `/staff/finance/contract-payables/${c.id}/disbursements`,
            acc(),
            {
              kind: 'retention_release',
              amount: '500.00',
            },
          ).expect(409),
        ),
      ).toMatchObject({ code: 'RETENTION_NOT_DUE' });
      await http('post', `/maintenance/contracts/${c.id}/terminate`, m(), {
        reasonCode: 'not_needed',
      }).expect(200);
      expect(
        err(
          await http(
            'post',
            `/staff/finance/contract-payables/${c.id}/disbursements`,
            acc(),
            {
              kind: 'retention_release',
              amount: '600.00',
            },
          ).expect(409),
        ),
      ).toMatchObject({
        code: 'RETENTION_EXCEEDED',
        params: { held: '500.00' },
      });
      const rel = (
        await http(
          'post',
          `/staff/finance/contract-payables/${c.id}/disbursements`,
          m(),
          {
            kind: 'retention_release',
            amount: '500.00',
          },
        ).expect(201)
      ).body as { id: string };
      expect(
        err(
          await http(
            'post',
            `/staff/finance/contract-disbursements/${rel.id}/approve`,
            m(),
          ).expect(409),
        ),
      ).toMatchObject({ code: 'PAYABLE_SELF_APPROVAL' });
    });

    it('a guarantee’s expiry is told once; it is returned once', async () => {
      const c = await contract();
      const g = (
        await http(
          'post',
          `/staff/finance/contract-payables/${c.id}/guarantees`,
          acc(),
          {
            kind: 'performance',
            issuer: 'Nile Bank',
            reference: `LG-${uniqueSuffix()}`,
            amount: '6000.00',
            issuedOn: day(-100),
            expiresOn: day(20),
          },
        ).expect(201)
      ).body as { id: string };
      const sweep = () =>
        h.moduleRef.get(SweepRunner).run(GUARANTEE_SWEEP, new Date());
      await sweep();
      await sweep();
      expect(
        await f.inTx(s.c, (tx) =>
          tx.notification.count({
            where: {
              kind: 'vendor_guarantee.expiring',
              targetId: g.id,
              accountId: s.accountant.id,
            },
          }),
        ),
      ).toBe(1);
      await http(
        'post',
        `/staff/finance/vendor-guarantees/${g.id}/close`,
        m(),
        {
          outcome: 'returned',
        },
      ).expect(200);
      expect(
        err(
          await http(
            'post',
            `/staff/finance/vendor-guarantees/${g.id}/close`,
            m(),
            {
              outcome: 'called',
            },
          ).expect(409),
        ),
      ).toMatchObject({ code: 'GUARANTEE_STATE' });
    });
  });

  it('the entries export holds every money event of the period once', async () => {
    const res = await http(
      'get',
      `/staff/finance/reports/entries/export?from=${budget.startsOn}&to=${today()}`,
      acc(),
    ).expect(200);
    const rows = res.text.trim().split('\r\n');
    expect(rows[0]).toContain('date,kind,reference,id');
    const kinds = new Set(rows.slice(1).map((r) => r.split(',')[1]));
    for (const k of [
      'expense',
      'invoice_approved',
      'payout',
      'commitment',
      'commitment_release',
      'budget_transfer',
    ])
      expect(kinds).toContain(k);
    const ids = rows
      .slice(1)
      .map((r) => `${r.split(',')[1]}:${r.split(',')[3]}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
