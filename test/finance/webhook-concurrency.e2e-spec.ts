import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { financeHelpers } from '../setup/finance';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { FakePaymob } from '../setup/paymob-fake';

/**
 * Callbacks at the same time (ADR 0046): one transaction delivered four
 * times at once is one payment; the session succeeds once.
 */
describe('Finance — webhook concurrency (races)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  const paymob = new FakePaymob();

  beforeAll(async () => {
    h = await createHttpHarness({ paymob });
    f = financeHelpers(h);
  });

  afterAll(() => h.close());

  it('four deliveries of one transaction at once: one payment', async () => {
    const s = await f.setUp('Webhook Race');
    const creds = await f.configureGateway(s.manager);
    await f.issue(s.manager, s.home.id);
    const res = await f
      .http('post', `/units/${s.home.id}/payment-sessions`, s.owner.token, {})
      .expect(201);
    const sessionId = (res.body as { id: string }).id;
    const intention = paymob.byReference(`jw-${sessionId}`);
    intention.paid = true;
    const cb = paymob.callback(intention, creds.hmacSecret);
    const answers = await Promise.all(
      [0, 1, 2, 3].map(() =>
        h
          .http()
          .post(`${API}/public/payments/paymob/${s.c.tenantId}?hmac=${cb.hmac}`)
          .send(cb.body),
      ),
    );
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200]);
    const rows = await f.x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx(async (tx) => ({
        payments: await tx.financePayment.count({ where: { sessionId } }),
        allocations: await tx.financeAllocation.count({
          where: { payment: { sessionId } },
        }),
        outcomes: (
          await tx.paymentGatewayEvent.findMany({ where: { sessionId } })
        ).map((e) => e.outcome),
        session: await tx.paymentSession.findUniqueOrThrow({
          where: { id: sessionId },
        }),
      })),
    );
    expect(rows.payments).toBe(1);
    expect(rows.allocations).toBe(1);
    expect(rows.outcomes.sort()).toEqual([
      'applied',
      'duplicate',
      'duplicate',
      'duplicate',
    ]);
    expect(rows.session.status).toBe('succeeded');
  });
});
