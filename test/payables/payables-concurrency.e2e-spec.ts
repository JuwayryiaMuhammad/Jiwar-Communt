import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { clock, day } from '../setup/compound-clock';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0089's races: two approvals of one invoice, one invoice paid twice,
 * a commitment and a budget transfer meeting on one line, and one vendor's
 * invoice number recorded twice at once.
 */
describe('Payables and commitments — concurrency (ADR 0089)', () => {
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
        { category: 'maintenance', amount: '500000.00' },
        { category: 'cleaning', amount: '90000.00' },
        { category: 'landscaping', amount: '10000.00' },
      ],
    );
    await f
      .http('patch', '/staff/governance/settings', s.manager.token, {
        items: [{ type: 'major_contract', threshold: '100000.00' }],
      })
      .expect(200);
  }, 240_000);

  afterAll(() => h.close());

  const m = () => s.manager.token;
  const acc = () => s.accountant.token;
  const line = (c: string) => budget.lines.find((l) => l.category === c)!;
  const availableOf = async (c: string) =>
    Number(
      (
        (await f.budgetView(s.accountant, budget.id)).lines.find(
          (l) => l.category === c,
        ) as unknown as { available: string }
      ).available,
    );
  const contract = async () => {
    const v = (
      (
        await f
          .http('post', '/staff/vendors', m(), {
            name: `Race Payee ${uniqueSuffix()}`,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    return (
      (
        await f
          .http('post', '/maintenance/contracts', m(), {
            code: `RC-${uniqueSuffix()}`,
            kind: 'amc',
            vendorId: v,
            startsOn: day(-30),
            endsOn: day(300),
            budgetLineId: line('maintenance').id,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  };
  const record = async (contractId: string, vendorNumber?: string) =>
    f.http('post', '/staff/finance/vendor-invoices', acc(), {
      contractId,
      vendorNumber: vendorNumber ?? `R-${uniqueSuffix()}`,
      issuedOn: clock().today,
      dueOn: day(5),
      invoiceFileId: await f.invoice(s.accountant),
      lines: [{ description: 'Work', amount: '1000.00' }],
    });

  it('two approvals of one invoice at once: one approves it, the other is told', async () => {
    for (let i = 0; i < 3; i++) {
      const inv = (
        (await (await record(await contract())).expect(201)).body as {
          id: string;
        }
      ).id;
      const approve = () =>
        f.http(
          'post',
          `/staff/finance/vendor-invoices/${inv}/approve`,
          m(),
          {},
        );
      const results = await Promise.all([approve(), approve()]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)!.body).toMatchObject({
        code: 'VENDOR_INVOICE_STATE',
      });
      const releases = await f.inTx(s.c, (tx) =>
        tx.auditLog.count({
          where: { action: 'vendor_invoice.approved', targetId: inv },
        }),
      );
      expect(releases).toBe(1);
    }
  });

  it('one invoice paid twice at once: one payout and one expense', async () => {
    for (let i = 0; i < 3; i++) {
      const inv = (
        (await (await record(await contract())).expect(201)).body as {
          id: string;
        }
      ).id;
      await f
        .http('post', `/staff/finance/vendor-invoices/${inv}/approve`, m(), {})
        .expect(200);
      const pay = () =>
        f.http('post', `/staff/finance/vendor-invoices/${inv}/pay`, acc(), {
          paidOn: clock().today,
          method: 'bank_transfer',
        });
      const results = await Promise.all([pay(), pay()]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const counts = await f.inTx(s.c, async (tx) => ({
        payouts: await tx.financeVendorPayout.count({
          where: { vendorInvoiceId: inv },
        }),
        expenses: await tx.financeExpense.count({
          where: { vendorInvoiceId: inv },
        }),
      }));
      expect(counts).toEqual({ payouts: 1, expenses: 1 });
    }
  });

  it('a commitment and a transfer meeting on one line never take the same money', async () => {
    for (let i = 0; i < 3; i++) {
      const left = await availableOf('cleaning');
      const each = Math.ceil(left * 0.6).toFixed(2);
      const pr = (
        (
          await f
            .http('post', '/staff/purchase-requests', acc(), {
              title: `Machines ${i}`,
              estimatedAmount: each,
              budgetLineId: line('cleaning').id,
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      const [approved, moved] = await Promise.all([
        f.http('post', `/staff/purchase-requests/${pr}/approve`, m(), {}),
        f.http('post', '/staff/finance/budget-transfers', acc(), {
          fromLineId: line('cleaning').id,
          toLineId: line('landscaping').id,
          amount: each,
          reason: 'Race',
        }),
      ]);
      const ok = [approved.status === 200, moved.status === 201];
      expect(ok.filter(Boolean)).toHaveLength(1);
      const loser = ok[0] ? moved : approved;
      expect(loser.status).toBe(409);
      expect(loser.body).toMatchObject({ code: 'BUDGET_LINE_INSUFFICIENT' });
      expect(await availableOf('cleaning')).toBeGreaterThanOrEqual(0);
      expect(left - (await availableOf('cleaning'))).toBeCloseTo(
        Number(each),
        2,
      );
      // Give the money back for the next round.
      if (ok[0])
        await f
          .http('post', `/staff/purchase-requests/${pr}/cancel`, m(), {
            reasonCode: 'not_needed',
          })
          .expect(200);
      else
        await f
          .http('post', '/staff/finance/budget-transfers', acc(), {
            fromLineId: line('landscaping').id,
            toLineId: line('cleaning').id,
            amount: each,
            reason: 'Back',
          })
          .expect(201);
    }
  });

  it('one vendor’s invoice number twice at once: one is recorded', async () => {
    for (let i = 0; i < 3; i++) {
      const c = await contract();
      const number = `TWIN-${uniqueSuffix()}`;
      const [a, b] = await Promise.all([
        record(c, number),
        record(c, number.toLowerCase()),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect((a.status === 409 ? a : b).body).toMatchObject({
        code: 'VENDOR_INVOICE_DUPLICATE',
      });
      const live = await f.inTx(s.c, (tx) =>
        tx.financeVendorInvoice.count({
          where: {
            contractId: c,
            vendorNumber: { equals: number, mode: 'insensitive' },
          },
        }),
      );
      expect(live).toBe(1);
    }
  });
});
