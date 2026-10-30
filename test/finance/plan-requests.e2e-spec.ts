import { InvoiceRemindersSweep } from '../../src/finance/invoices/invoice-reminders.sweep';
import { err } from '../api/request';
import { day } from '../setup/compound-clock';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface PlanRequest {
  id: string;
  invoiceId: string;
  months: number;
  status: string;
  declineReason: string | null;
  planId: string | null;
}

const halves = {
  instalments: [
    { dueOn: day(10), amount: '500' },
    { dueOn: day(40), amount: '500' },
  ],
};

/**
 * ADR 0069: a payment plan a resident asks for — on an invoice it still
 * owes, in at most the compound's months, one waiting at a time; accepted
 * as a plan the staff set by their own path, declined with a reason or
 * withdrawn; lapsed when the invoice stops owing; offered once with the
 * due-soon notice above the compound's floor.
 */
describe('Finance — payment plans residents ask for', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    s = await f.setUp('Plan Request Court');
  }, 90_000);

  afterAll(() => h.close());

  const ask = (invoiceId: string, months = 3, token = s.owner.token) =>
    f.http('post', `/invoices/${invoiceId}/plan-requests`, token, { months });
  const asked = async (invoiceId: string, months = 3) =>
    (await ask(invoiceId, months).expect(201)).body as PlanRequest;
  const staff = (path: string, body?: object) =>
    f.http('post', `/staff/plan-requests/${path}`, s.accountant.token, body);
  const read = async (id: string, token = s.owner.token) =>
    (await f.http('get', `/plan-requests/${id}`, token).expect(200))
      .body as PlanRequest;
  const told = (accountId: string, kind: string, targetId: string) =>
    f.inTx(s.c, (tx) =>
      tx.notification.findMany({ where: { accountId, kind, targetId } }),
    );

  it('asked on an invoice it owes, at most the compound’s months, one waiting at a time; the staff are told', async () => {
    const { invoiceId } = await f.issue(s.accountant, s.home.id);
    expect(err(await ask(invoiceId, 7).expect(400)).fields).toEqual([
      { field: 'months', code: 'INVALID_VALUE', params: { max: 6 } },
    ]);
    const r = await asked(invoiceId, 4);
    expect(r).toMatchObject({ invoiceId, months: 4, status: 'pending' });
    expect(err(await ask(invoiceId).expect(409))).toMatchObject({
      code: 'PLAN_REQUEST_PENDING',
      params: { requestId: r.id },
    });
    expect(
      await told(s.accountant.id, 'instalment_plan_request.submitted', r.id),
    ).toHaveLength(1);
    // The invoice says one waits.
    const detail = (
      await f.http('get', `/invoices/${invoiceId}`, s.owner.token).expect(200)
    ).body as { planOffer: object };
    expect(detail.planOffer).toEqual({
      mayRequest: false,
      offered: false,
      maxMonths: 6,
      pendingRequestId: r.id,
    });
    // It shows in the resident's requests.
    const mine = (
      await f.http('get', '/me/requests', s.owner.token).expect(200)
    ).body as { data: { type: string; id: string; status: string }[] };
    expect(mine.data).toContainEqual(
      expect.objectContaining({
        type: 'instalment_plan_request',
        id: r.id,
        status: 'pending',
      }),
    );
  });

  it('accepted with the instalments the staff set: the plan is made, the requester told; decided once', async () => {
    const { invoiceId } = await f.issue(s.accountant, s.home.id);
    const r = await asked(invoiceId);
    const accepted = (await staff(`${r.id}/accept`, halves).expect(201))
      .body as PlanRequest;
    expect(accepted).toMatchObject({ status: 'accepted' });
    expect(accepted.planId).not.toBeNull();
    const plan = await f.inTx(s.c, (tx) =>
      tx.instalmentPlan.findUniqueOrThrow({ where: { id: accepted.planId! } }),
    );
    expect(plan.invoiceId).toBe(invoiceId);
    expect(
      await told(s.owner.id, 'instalment_plan_request.accepted', r.id),
    ).toHaveLength(1);
    expect(
      err(await staff(`${r.id}/decline`, { reasonCode: 'other' }).expect(409)),
    ).toMatchObject({
      code: 'PLAN_REQUEST_NOT_PENDING',
      params: { status: 'accepted' },
    });
  });

  it('declined with a reason from the list; withdrawn only by its requester while it waits', async () => {
    const one = await asked((await f.issue(s.accountant, s.home.id)).invoiceId);
    expect(err(await staff(`${one.id}/decline`, {}).expect(400)).code).toBe(
      'REASON_REQUIRED',
    );
    const declined = (
      await staff(`${one.id}/decline`, {
        reasonCode: 'payment_history',
      }).expect(201)
    ).body as PlanRequest;
    expect(declined).toMatchObject({
      status: 'declined',
      declineReason: 'payment_history',
    });
    const [notice] = await told(
      s.owner.id,
      'instalment_plan_request.declined',
      one.id,
    );
    expect(notice.params).toEqual({ reasonCode: 'payment_history' });

    const two = await asked((await f.issue(s.accountant, s.home.id)).invoiceId);
    const member = await f.family(s.c, s.home.id, s.owner);
    await f.grantFinance(s.c, s.owner, member.memberId);
    await f
      .http('post', `/plan-requests/${two.id}/withdraw`, member.token)
      .expect(404);
    expect(
      (
        (
          await f
            .http('post', `/plan-requests/${two.id}/withdraw`, s.owner.token)
            .expect(201)
        ).body as PlanRequest
      ).status,
    ).toBe('withdrawn');
  });

  it('who asks: whoever pays the unit’s money; anyone else finds no invoice', async () => {
    const { invoiceId } = await f.issue(s.accountant, s.home.id);
    const stranger = await f.owner(s.c, (await f.unit(s.c, 'B')).id);
    expect(err(await ask(invoiceId, 3, stranger.token).expect(404)).code).toBe(
      'INVOICE_NOT_FOUND',
    );
    const member = await f.family(s.c, s.home.id, s.owner);
    await ask(invoiceId, 3, member.token).expect(404);
  });

  const payAll = (invoiceId: string) =>
    f.http('post', `/staff/units/${s.home.id}/payments`, s.accountant.token, {
      amount: '1000',
      method: 'cash',
      paidOn: day(0),
      invoiceIds: [invoiceId],
    });
  const stored = (id: string) =>
    f.inTx(s.c, (tx) =>
      tx.instalmentPlanRequest.findUniqueOrThrow({ where: { id } }),
    );

  it('lapses when the invoice stops owing, whatever paid it; accepting it then is refused, and nothing changes', async () => {
    const { invoiceId } = await f.issue(s.accountant, s.home.id);
    const r = await asked(invoiceId);
    await payAll(invoiceId).expect(201);
    expect((await read(r.id)).status).toBe('lapsed');
    const refused = err(await staff(`${r.id}/accept`, halves).expect(409));
    expect(refused.code).toBe('PLAN_REQUEST_LAPSED');
    expect(refused.params).toBeUndefined();
    // Refused, not written: no plan, no decision, no notice.
    expect(
      await f.inTx(s.c, (tx) =>
        tx.instalmentPlan.count({ where: { invoiceId } }),
      ),
    ).toBe(0);
    expect(await stored(r.id)).toMatchObject({
      status: 'pending',
      decidedAt: null,
      planId: null,
    });
    expect(
      await told(s.owner.id, 'instalment_plan_request.accepted', r.id),
    ).toEqual([]);
    expect(err(await ask(invoiceId).expect(409)).params).toEqual({
      reason: 'nothing_owed',
    });
  });

  it('a lapsed request is not declined either: the invoice was split by the staff meanwhile', async () => {
    const { invoiceId } = await f.issue(s.accountant, s.home.id);
    const r = await asked(invoiceId);
    await f
      .http(
        'post',
        `/staff/invoices/${invoiceId}/instalment-plan`,
        s.manager.token,
        halves,
      )
      .expect(201);
    expect((await read(r.id)).status).toBe('lapsed');
    expect(
      err(await staff(`${r.id}/decline`, { reasonCode: 'other' }).expect(409))
        .code,
    ).toBe('PLAN_REQUEST_LAPSED');
    expect(await stored(r.id)).toMatchObject({
      status: 'pending',
      declineReason: null,
    });
    expect(
      await told(s.owner.id, 'instalment_plan_request.declined', r.id),
    ).toEqual([]);
  });

  it('offered once with the due-soon notice, above the compound’s floor only', async () => {
    await f
      .http('patch', '/staff/finance/plan-settings', s.accountant.token, {
        planOfferMinAmount: '800',
      })
      .expect(200);
    const big = await f.issue(s.accountant, s.home.id, { dueOn: day(2) });
    const small = await f.issue(s.accountant, s.home.id, {
      dueOn: day(2),
      lines: [{ descriptionEn: 'Small', descriptionAr: 'صغير', amount: '100' }],
    });
    const sweep = () => h.moduleRef.get(InvoiceRemindersSweep).run();
    await sweep();
    await sweep();
    expect(
      await told(s.owner.id, 'invoice.plan_available', big.invoiceId),
    ).toHaveLength(1);
    expect(
      await told(s.owner.id, 'invoice.plan_available', small.invoiceId),
    ).toEqual([]);
    const detail = (
      await f
        .http('get', `/invoices/${big.invoiceId}`, s.owner.token)
        .expect(200)
    ).body as { planOffer: object };
    expect(detail.planOffer).toMatchObject({ mayRequest: true, offered: true });
  });

  describe('races', () => {
    it('two asks on one invoice at once leave one waiting', async () => {
      const { invoiceId } = await f.issue(s.accountant, s.home.id);
      const both = await Promise.all([ask(invoiceId), ask(invoiceId)]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        await f.inTx(s.c, (tx) =>
          tx.instalmentPlanRequest.count({
            where: { invoiceId, status: 'pending' },
          }),
        ),
      ).toBe(1);
    });

    it.each([1, 2, 3])(
      'round %i: an acceptance and the payment that settles the invoice: one wins, never both',
      async () => {
        const { invoiceId } = await f.issue(s.accountant, s.home.id);
        const r = await asked(invoiceId);
        const [accepted, paid] = await Promise.all([
          staff(`${r.id}/accept`, halves),
          payAll(invoiceId),
        ]);
        const plans = await f.inTx(s.c, (tx) =>
          tx.instalmentPlan.count({ where: { invoiceId } }),
        );
        if (accepted.status === 201) {
          // The plan took the invoice first; the payment paid its instalments.
          expect(plans).toBe(1);
          expect((await read(r.id)).status).toBe('accepted');
        } else {
          // The payment settled it first: the acceptance found it lapsed.
          expect(accepted.status).toBe(409);
          expect(paid.status).toBe(201);
          expect(err(accepted).code).toBe('PLAN_REQUEST_LAPSED');
          expect(plans).toBe(0);
          expect(await stored(r.id)).toMatchObject({
            status: 'pending',
            planId: null,
          });
          expect((await read(r.id)).status).toBe('lapsed');
        }
      },
    );

    it('an acceptance and a withdrawal: one of the two', async () => {
      const r = await asked((await f.issue(s.accountant, s.home.id)).invoiceId);
      const results = await Promise.all([
        staff(`${r.id}/accept`, halves),
        f.http('post', `/plan-requests/${r.id}/withdraw`, s.owner.token),
      ]);
      expect(results.map((x) => x.status).sort()).toEqual([201, 409]);
      expect(['accepted', 'withdrawn']).toContain((await read(r.id)).status);
    });
  });
});
