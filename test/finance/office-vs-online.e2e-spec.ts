import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { day } from '../setup/facilities';
import { financeHelpers } from '../setup/finance';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { FakePaymob } from '../setup/paymob-fake';

/**
 * An office payment and an online one on the same invoice at the same time
 * (ADR 0046): both take the unit's finance lock. The office never takes
 * more than is owed; the online payment always lands (the money was taken)
 * and what nothing owed absorbs becomes the unit's credit. Never more paid
 * to an invoice than it asks.
 */
describe('Finance — office vs online (races)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  const paymob = new FakePaymob();

  beforeAll(async () => {
    h = await createHttpHarness({ paymob });
    f = financeHelpers(h);
  });

  afterAll(() => h.close());

  it.each([1, 2, 3])(
    'round %i: one invoice, the office and the webhook at once',
    async () => {
      const s = await f.setUp('Office Online Race');
      const creds = await f.configureGateway(s.manager);
      const { invoiceId } = await f.issue(s.manager, s.home.id);
      const res = await f
        .http('post', `/units/${s.home.id}/payment-sessions`, s.owner.token, {})
        .expect(201);
      const sessionId = (res.body as { id: string }).id;
      const intention = paymob.byReference(`jw-${sessionId}`);
      intention.paid = true;
      const cb = paymob.callback(intention, creds.hmacSecret);
      const [office, webhook] = await Promise.all([
        f.http(
          'post',
          `/staff/units/${s.home.id}/payments`,
          s.accountant.token,
          {
            amount: '1000',
            method: 'cash',
            paidOn: day(0),
          },
        ),
        h
          .http()
          .post(`${API}/public/payments/paymob/${s.c.tenantId}?hmac=${cb.hmac}`)
          .send(cb.body),
      ]);
      expect(webhook.status).toBe(200);
      expect([201, 409]).toContain(office.status);
      const statement = (
        await f
          .http('get', `/units/${s.home.id}/statement`, s.owner.token)
          .expect(200)
      ).body as { outstanding: string; credit: string };
      const invoice = (
        await f
          .http('get', `/staff/invoices/${invoiceId}`, s.manager.token)
          .expect(200)
      ).body as { paid: string; outstanding: string };
      expect(invoice).toMatchObject({ paid: '1000.00', outstanding: '0.00' });
      const payments = await f.x.asManager(s.c, () =>
        h.moduleRef.get(TenantTx).withTenantTx((tx) =>
          tx.financePayment.count({
            where: { unitId: s.home.id, kind: 'payment' },
          }),
        ),
      );
      if (office.status === 201) {
        // The office won the lock: the online money is the unit's credit.
        expect(payments).toBe(2);
        expect(statement).toMatchObject({
          outstanding: '0.00',
          credit: '1000.00',
        });
      } else {
        expect((office.body as { code: string }).code).toBe(
          'PAYMENT_EXCEEDS_OUTSTANDING',
        );
        expect(payments).toBe(1);
        expect(statement).toMatchObject({
          outstanding: '0.00',
          credit: '0.00',
        });
      }
    },
  );
});
