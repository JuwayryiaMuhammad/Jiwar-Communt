import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { INVOICE_REMINDERS_SWEEP } from '../../src/finance/invoices/invoice-reminders.sweep';
import { day } from '../setup/facilities';
import { backdateInvoice, financeHelpers } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * Reminders (ADR 0046): three days before an invoice still owed falls due,
 * and the day after it did; each once, to whoever sees the unit's money;
 * nothing for what is paid or credited; no late fee.
 */
describe('Finance — reminders', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
  });

  afterAll(() => h.close());

  const sweep = () =>
    h.moduleRef.get(SweepRunner).run(INVOICE_REMINDERS_SWEEP, new Date());

  it('due soon three days before, once; not before', async () => {
    const s = await f.setUp('Reminders Soon');
    const soon = await f.issue(s.manager, s.home.id, { dueOn: day(3) });
    const later = await f.issue(s.manager, s.home.id, { dueOn: day(4) });
    await sweep();
    await sweep();
    const told = await f.notifications(s.c, s.owner.id, 'invoice.due_soon');
    expect(told.map((n) => [n.targetId, n.params])).toEqual([
      [soon.invoiceId, {}],
    ]);
    expect(told.map((n) => n.targetId)).not.toContain(later.invoiceId);
  });

  it('overdue the day after, once; the invoice reads overdue', async () => {
    const s = await f.setUp('Reminders Overdue');
    const late = await f.issue(s.manager, s.home.id, { dueOn: day(0) });
    await sweep();
    expect(await f.notifications(s.c, s.owner.id, 'invoice.overdue')).toEqual(
      [],
    );
    await backdateInvoice(late.invoiceId, 1);
    await sweep();
    await sweep();
    expect(
      (await f.notifications(s.c, s.owner.id, 'invoice.overdue')).map(
        (n) => n.targetId,
      ),
    ).toEqual([late.invoiceId]);
    const res = await f
      .http('get', `/invoices/${late.invoiceId}`, s.owner.token)
      .expect(200);
    expect((res.body as { status: string; total: string }).status).toBe(
      'overdue',
    );
    // No late fee: the total is unchanged.
    expect((res.body as { total: string }).total).toBe('1000.00');
  });

  it('nothing for an invoice paid or credited in full', async () => {
    const s = await f.setUp('Reminders Settled');
    const paid = await f.issue(s.manager, s.home.id, { dueOn: day(1) });
    const credited = await f.issue(s.manager, s.home.id, { dueOn: day(1) });
    await f
      .http('post', `/staff/units/${s.home.id}/payments`, s.accountant.token, {
        amount: '1000',
        method: 'cash',
        paidOn: day(0),
        invoiceIds: [paid.invoiceId],
      })
      .expect(201);
    await f
      .http(
        'post',
        `/staff/invoices/${credited.invoiceId}/credit-notes`,
        s.manager.token,
        {
          amount: '1000',
          reasonCode: 'waiver',
        },
      )
      .expect(201);
    await sweep();
    expect(await f.notifications(s.c, s.owner.id, 'invoice.due_soon')).toEqual(
      [],
    );
  });
});
