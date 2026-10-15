import { financeHelpers } from '../setup/finance';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { FakePaymob } from '../setup/paymob-fake';

/**
 * A dispute accepted while a payment lands on its invoice (ADR 0048): both
 * take the unit's finance lock. While open the invoice cannot be paid by
 * name, so the only payment that can still reach it is a checkout opened
 * before the dispute and paid late (the money was taken). Whoever wins, the
 * invoice is never credited and paid beyond its total, and no money is
 * lost: what nothing owed absorbs is the unit's credit.
 */
describe('Finance — dispute vs payment (races)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  const paymob = new FakePaymob();

  beforeAll(async () => {
    h = await createHttpHarness({ paymob });
    f = financeHelpers(h);
  });

  afterAll(() => h.close());

  it.each([1, 2, 3])(
    'round %i: an acceptance and a late checkout success at once',
    async () => {
      const s = await f.setUp('Dispute Payment Race');
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
      const disputeId = (
        (
          await f
            .http('post', `/invoices/${invoiceId}/disputes`, s.owner.token, {
              reasonCode: 'wrong_amount',
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      const intention = paymob.byReference(`jw-${sessionId}`);
      intention.paid = true;
      const cb = paymob.callback(intention, creds.hmacSecret);
      const [accept, webhook] = await Promise.all([
        f.http(
          'post',
          `/staff/invoice-disputes/${disputeId}/decide`,
          s.accountant.token,
          { decision: 'accept', amount: '1000' },
        ),
        h
          .http()
          .post(`${API}/public/payments/paymob/${s.c.tenantId}?hmac=${cb.hmac}`)
          .send(cb.body),
      ]);
      expect(webhook.status).toBe(200);
      const invoice = (
        await f
          .http('get', `/staff/invoices/${invoiceId}`, s.manager.token)
          .expect(200)
      ).body as { credited: string; paid: string; outstanding: string };
      const statement = (
        await f
          .http('get', `/units/${s.home.id}/statement`, s.owner.token)
          .expect(200)
      ).body as { outstanding: string; credit: string };
      expect(invoice.outstanding).toBe('0.00');
      if (accept.status === 201) {
        // The acceptance won: the late money is the unit's credit.
        expect(invoice).toMatchObject({ credited: '1000.00', paid: '0.00' });
        expect(statement).toMatchObject({
          outstanding: '0.00',
          credit: '1000.00',
        });
      } else {
        // The money won: nothing is left to credit.
        expect(accept.body).toMatchObject({
          code: 'CREDIT_EXCEEDS_OUTSTANDING',
          params: { outstanding: '0.00' },
        });
        expect(invoice).toMatchObject({ credited: '0.00', paid: '1000.00' });
        expect(statement).toMatchObject({
          outstanding: '0.00',
          credit: '0.00',
        });
      }
    },
  );
});
