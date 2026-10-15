import { day } from '../setup/facilities';
import { financeHelpers } from '../setup/finance';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { FakePaymob } from '../setup/paymob-fake';

interface Plan {
  status: string;
  outstanding: string;
  instalments: { paid: string; outstanding: string }[];
}

/**
 * Splitting an invoice into instalments while a payment lands on it (ADR
 * 0048): both take the unit's finance lock. The split must add up to what is
 * owed when it runs, so a payment that wins first refuses it with the new
 * figure; a payment that comes after pays the instalments, oldest due first.
 * Never more paid than asked, never money lost.
 */
describe('Finance — instalments vs payment (races)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  const paymob = new FakePaymob();

  beforeAll(async () => {
    h = await createHttpHarness({ paymob });
    f = financeHelpers(h);
  });

  afterAll(() => h.close());

  const split = [
    { dueOn: day(5), amount: '500' },
    { dueOn: day(35), amount: '500' },
  ];

  it.each([1, 2, 3])(
    'round %i: an office payment and a split at once',
    async () => {
      const s = await f.setUp('Split Office Race');
      const { invoiceId } = await f.issue(s.manager, s.home.id);
      const [convert, office] = await Promise.all([
        f.http(
          'post',
          `/staff/invoices/${invoiceId}/instalment-plan`,
          s.manager.token,
          { instalments: split },
        ),
        f.http(
          'post',
          `/staff/units/${s.home.id}/payments`,
          s.accountant.token,
          { amount: '400', method: 'cash', paidOn: day(0) },
        ),
      ]);
      expect(office.status).toBe(201);
      const statement = (
        await f
          .http('get', `/units/${s.home.id}/statement`, s.owner.token)
          .expect(200)
      ).body as { outstanding: string; credit: string };
      expect(statement).toEqual(
        expect.objectContaining({ outstanding: '600.00', credit: '0.00' }),
      );
      if (convert.status === 201) {
        // The split won: the payment paid the first instalment.
        const plan = (
          await f
            .http(
              'get',
              `/staff/instalment-plans/${(convert.body as { id: string }).id}`,
              s.manager.token,
            )
            .expect(200)
        ).body as Plan;
        expect(plan.instalments.map((i) => i.paid)).toEqual(['400.00', '0.00']);
      } else {
        expect(convert.status).toBe(409);
        expect(convert.body).toMatchObject({
          code: 'INSTALMENTS_DONT_ADD_UP',
          params: { outstanding: '600.00' },
        });
      }
    },
  );

  it.each([1, 2, 3])(
    'round %i: a checkout of the original paid while it is split',
    async () => {
      const s = await f.setUp('Split Online Race');
      const creds = await f.configureGateway(s.manager);
      const { invoiceId } = await f.issue(s.manager, s.home.id);
      const sessionId = (
        (
          await f
            .http(
              'post',
              `/units/${s.home.id}/payment-sessions`,
              s.owner.token,
              {},
            )
            .expect(201)
        ).body as { id: string }
      ).id;
      const intention = paymob.byReference(`jw-${sessionId}`);
      intention.paid = true;
      const cb = paymob.callback(intention, creds.hmacSecret);
      const [convert, webhook] = await Promise.all([
        f.http(
          'post',
          `/staff/invoices/${invoiceId}/instalment-plan`,
          s.manager.token,
          { instalments: split },
        ),
        h
          .http()
          .post(`${API}/public/payments/paymob/${s.c.tenantId}?hmac=${cb.hmac}`)
          .send(cb.body),
      ]);
      expect(webhook.status).toBe(200);
      const statement = (
        await f
          .http('get', `/units/${s.home.id}/statement`, s.owner.token)
          .expect(200)
      ).body as { outstanding: string; credit: string };
      // Whoever won, the money paid what was owed, and nothing is left over.
      expect(statement).toEqual(
        expect.objectContaining({ outstanding: '0.00', credit: '0.00' }),
      );
      if (convert.status === 201) {
        // The split won; the late success paid its instalments.
        const plan = (
          await f
            .http(
              'get',
              `/staff/instalment-plans/${(convert.body as { id: string }).id}`,
              s.manager.token,
            )
            .expect(200)
        ).body as Plan;
        expect(plan).toMatchObject({ status: 'settled', outstanding: '0.00' });
      } else {
        expect(convert.body).toMatchObject({
          code: 'INVOICE_NOT_CONVERTIBLE',
          params: { reason: 'nothing_owed' },
        });
      }
    },
  );
});
