import type { Response } from 'supertest';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { VERIFY_SWEEP } from '../../src/finance/online/paymob-webhook.service';
import { SESSION_EXPIRY_SWEEP } from '../../src/finance/online/payment-sessions.service';
import { auditReaders } from '../setup/audit';
import { day } from '../setup/facilities';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { FakePaymob, type FakeIntention } from '../setup/paymob-fake';

const body = <T>(res: Response) => res.body as T;

/**
 * The Paymob webhook (ADR 0046): HMAC first, the same 401 for everything
 * refused; the signed order binds a callback to its checkout; amount and
 * currency exact; a mandatory check with Paymob; a transaction pays once.
 */
describe('Finance — Paymob webhook', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  const paymob = new FakePaymob();

  beforeAll(async () => {
    h = await createHttpHarness({ paymob });
    f = financeHelpers(h);
  });

  afterAll(() => h.close());

  afterEach(() => {
    paymob.lookup = 'held';
  });

  type Online = FinanceSetUp & { creds: { hmacSecret: string } };

  async function online(name: string): Promise<Online> {
    const s = await f.setUp(name);
    const creds = await f.configureGateway(s.manager);
    return { ...s, creds };
  }

  /** A checkout for everything the home owes, and its intention at Paymob. */
  async function checkout(s: Online, payer = s.owner) {
    const res = await f
      .http('post', `/units/${s.home.id}/payment-sessions`, payer.token, {})
      .expect(201);
    const session = body<{ id: string }>(res);
    return {
      sessionId: session.id,
      intention: paymob.byReference(`jw-${session.id}`),
    };
  }

  const post = (tenantId: string, hmac: string | undefined, b: object) =>
    h
      .http()
      .post(
        `${API}/public/payments/paymob/${tenantId}${hmac === undefined ? '' : `?hmac=${hmac}`}`,
      )
      .send(b);

  /** Paymob pays the intention and calls back, signed. */
  function paid(
    s: Online,
    i: FakeIntention,
    over: Record<string, unknown> = {},
    after?: (obj: Record<string, unknown>) => void,
  ) {
    i.paid = true;
    const cb = paymob.callback(i, s.creds.hmacSecret, over, after);
    return { cb, send: () => post(s.c.tenantId, cb.hmac, cb.body) };
  }

  const sessionOf = (s: FinanceSetUp, id: string) =>
    f.x.asManager(s.c, () =>
      h.moduleRef
        .get(TenantTx)
        .withTenantTx((tx) =>
          tx.paymentSession.findUniqueOrThrow({ where: { id } }),
        ),
    );
  const paymentsOf = (s: FinanceSetUp) =>
    f.x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        tx.financePayment.findMany({
          where: { unitId: s.home.id, kind: 'payment' },
          orderBy: { createdAt: 'asc' },
        }),
      ),
    );
  const eventsOf = (s: FinanceSetUp, sessionId: string) =>
    f.x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        tx.paymentGatewayEvent.findMany({
          where: { sessionId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      ),
    );
  const statement = async (s: FinanceSetUp) =>
    body<{ outstanding: string; credit: string }>(
      await f
        .http('get', `/units/${s.home.id}/statement`, s.owner.token)
        .expect(200),
    );

  it('a verified success pays the checkout’s invoices once; the receipt is online; the unit is told', async () => {
    const s = await online('Webhook Paid');
    const inv = await f.issue(s.manager, s.home.id);
    const { sessionId, intention } = await checkout(s);
    const { send, cb } = paid(s, intention);
    await send().expect(200);
    const session = await sessionOf(s, sessionId);
    expect(session.status).toBe('succeeded');
    const [payment] = await paymentsOf(s);
    expect(payment).toMatchObject({
      channel: 'online',
      method: 'card',
      sessionId,
      gatewayTransactionId: String(cb.body.obj.id),
      payerId: s.owner.id,
      recordedById: null,
    });
    expect(payment.amount?.toFixed(2)).toBe('1000.00');
    expect(session.paymentId).toBe(payment.id);
    const invoice = body<{ status: string }>(
      await f
        .http('get', `/staff/invoices/${inv.invoiceId}`, s.manager.token)
        .expect(200),
    );
    expect(invoice.status).toBe('paid');
    const polled = body<{ status: string; payment: { id: string } }>(
      await f
        .http('get', `/payment-sessions/${sessionId}`, s.owner.token)
        .expect(200),
    );
    expect(polled).toMatchObject({
      status: 'succeeded',
      payment: { id: payment.id },
    });
    expect(
      (await f.notifications(s.c, s.owner.id, 'payment.received')).map(
        (n) => n.targetId,
      ),
    ).toEqual([payment.id]);
    // Replayed: a no-op.
    await send().expect(200);
    expect(await paymentsOf(s)).toHaveLength(1);
    expect((await eventsOf(s, sessionId)).map((e) => e.outcome)).toEqual([
      'applied',
      'duplicate',
    ]);
    // The mandatory check was made.
    expect(
      paymob.requests.some(
        (r) =>
          r.method === 'GET' && r.url.includes(`/${intention.clientSecret}/`),
      ),
    ).toBe(true);
  });

  it('the same 401 for no hmac, a bad hmac, an unknown compound, no gateway, a malformed body', async () => {
    const s = await online('Webhook Refused');
    await f.issue(s.manager, s.home.id);
    const { intention } = await checkout(s);
    const { cb } = paid(s, intention);
    const answers = [
      await post(s.c.tenantId, undefined, cb.body),
      await post(s.c.tenantId, 'f'.repeat(128), cb.body),
      await post(s.c.tenantId, cb.hmac.slice(1), cb.body),
      await post('0190a1b2-0000-7000-8000-00000000dead', cb.hmac, cb.body),
      await post(
        (await f.setUp('Webhook No Gateway')).c.tenantId,
        cb.hmac,
        cb.body,
      ),
      await post(s.c.tenantId, cb.hmac, { obj: 'x' }),
      await post('not-a-uuid', cb.hmac, cb.body),
    ];
    for (const a of answers) {
      expect(a.status).toBe(401);
      expect(a.body).toEqual(answers[0].body);
    }
    expect(await paymentsOf(s)).toEqual([]);
    const rejected = await auditReaders(h).security({
      event: 'payment.webhook_rejected',
    });
    expect(rejected.some((r) => r.tenantId === s.c.tenantId)).toBe(true);
    // Signed with another compound's secret: refused.
    const other = await online('Webhook Other Secret');
    const forged = paymob.callback(intention, other.creds.hmacSecret);
    expect((await post(s.c.tenantId, forged.hmac, forged.body)).status).toBe(
      401,
    );
  });

  it('a signed success of one checkout replayed onto another: refused by the signed order', async () => {
    const s = await online('Webhook Replay');
    const rented = await f.unit(s.c, 'A');
    const tenant = await f.tenant(s.c, rented.id);
    await f.issue(s.manager, s.home.id);
    await f.issue(s.manager, rented.id);
    const a = await checkout(s);
    const resB = await f
      .http('post', `/units/${rented.id}/payment-sessions`, tenant.token, {})
      .expect(201);
    const bId = body<{ id: string }>(resB).id;
    // Paid A; the attacker rewrites the unsigned reference to B's.
    const { send } = paid(s, a.intention, {}, (obj) => {
      (obj.order as Record<string, unknown>).merchant_order_id = `jw-${bId}`;
    });
    await send().expect(200);
    expect((await sessionOf(s, bId)).status).toBe('open');
    expect((await eventsOf(s, bId)).map((e) => e.outcome)).toEqual([
      'order_mismatch',
    ]);
    expect(
      (
        await auditReaders(h).security({ event: 'payment.order_mismatch' })
      ).some((r) => r.tenantId === s.c.tenantId),
    ).toBe(true);
    // The manager follows it up in the callbacks' log.
    const log = await f
      .http(
        'get',
        '/staff/finance/gateway-events?outcome=order_mismatch',
        s.manager.token,
      )
      .expect(200);
    expect(
      (log.body as { data: { sessionId: string; amount: string }[] }).data,
    ).toEqual([expect.objectContaining({ sessionId: bId, amount: '1000.00' })]);
    await f
      .http('get', '/staff/finance/gateway-events', s.accountant.token)
      .expect(403);
  });

  it('an amount or currency that does not match exactly: nothing applied', async () => {
    const s = await online('Webhook Amount');
    await f.issue(s.manager, s.home.id);
    const { sessionId, intention } = await checkout(s);
    await paid(s, intention, { amount_cents: intention.amountCents - 1 })
      .send()
      .expect(200);
    await paid(s, intention, { currency: 'USD' }).send().expect(200);
    expect(await paymentsOf(s)).toEqual([]);
    expect((await eventsOf(s, sessionId)).map((e) => e.outcome)).toEqual([
      'amount_mismatch',
      'amount_mismatch',
    ]);
  });

  it('Paymob contradicts the success: nothing applied', async () => {
    const s = await online('Webhook Contradicted');
    await f.issue(s.manager, s.home.id);
    const { sessionId, intention } = await checkout(s);
    // Signed, but Paymob holds another amount for the intention.
    const real = intention.amountCents;
    intention.amountCents = real + 100;
    const { send } = paid(s, intention, { amount_cents: real });
    await send().expect(200);
    expect(await paymentsOf(s)).toEqual([]);
    expect((await eventsOf(s, sessionId)).map((e) => e.outcome)).toEqual([
      'contradicted',
    ]);
  });

  it('Paymob not answering yet: 500 (Paymob retries), nothing applied; the sweep applies it once confirmed', async () => {
    const s = await online('Webhook Pending');
    await f.issue(s.manager, s.home.id);
    const { sessionId, intention } = await checkout(s);
    const { send } = paid(s, intention);
    paymob.lookup = 'down';
    await send().expect(500);
    paymob.lookup = 'unpaid';
    await send().expect(500);
    expect(await paymentsOf(s)).toEqual([]);
    paymob.lookup = 'held';
    const sweep = h.moduleRef.get(SweepRunner);
    await sweep.run(VERIFY_SWEEP, new Date());
    expect(await paymentsOf(s)).toHaveLength(1);
    expect((await sessionOf(s, sessionId)).status).toBe('succeeded');
    // Paymob's own retry then: a no-op.
    await send().expect(200);
    expect(await paymentsOf(s)).toHaveLength(1);
  });

  it('a pending or failed attempt is logged; the checkout stays open for a retry', async () => {
    const s = await online('Webhook Attempts');
    await f.issue(s.manager, s.home.id);
    const { sessionId, intention } = await checkout(s);
    const pending = paymob.callback(intention, s.creds.hmacSecret, {
      pending: true,
    });
    await post(s.c.tenantId, pending.hmac, pending.body).expect(200);
    const failed = paymob.callback(intention, s.creds.hmacSecret, {
      success: false,
    });
    await post(s.c.tenantId, failed.hmac, failed.body).expect(200);
    expect((await sessionOf(s, sessionId)).status).toBe('open');
    const polled = body<{ lastAttempt: string | null }>(
      await f
        .http('get', `/payment-sessions/${sessionId}`, s.owner.token)
        .expect(200),
    );
    expect(polled.lastAttempt).toBe('failed');
    await paid(s, intention).send().expect(200);
    expect((await sessionOf(s, sessionId)).status).toBe('succeeded');
  });

  it('a late success after expiry still pays; after a supersede its excess becomes the unit’s credit', async () => {
    const s = await online('Webhook Late');
    const inv = await f.issue(s.manager, s.home.id);
    const first = await checkout(s);
    await h.moduleRef
      .get(SweepRunner)
      .run(SESSION_EXPIRY_SWEEP, new Date(Date.now() + 31 * 60_000));
    expect((await sessionOf(s, first.sessionId)).status).toBe('expired');
    await paid(s, first.intention).send().expect(200);
    expect((await sessionOf(s, first.sessionId)).status).toBe('succeeded');
    expect(
      body<{ status: string }>(
        await f
          .http('get', `/staff/invoices/${inv.invoiceId}`, s.manager.token)
          .expect(200),
      ).status,
    ).toBe('paid');

    // A second checkout, superseded by an office payment, then paid anyway.
    await f.issue(s.manager, s.home.id);
    const second = await checkout(s);
    await f
      .http('post', `/staff/units/${s.home.id}/payments`, s.accountant.token, {
        amount: '1000',
        method: 'cash',
        paidOn: day(0),
      })
      .expect(201);
    expect((await sessionOf(s, second.sessionId)).status).toBe('superseded');
    await paid(s, second.intention).send().expect(200);
    expect(await statement(s)).toEqual(
      expect.objectContaining({ outstanding: '0.00', credit: '1000.00' }),
    );
    // The credit pays the next invoice at once.
    const next = await f.issue(s.manager, s.home.id);
    expect(
      body<{ status: string }>(
        await f
          .http('get', `/staff/invoices/${next.invoiceId}`, s.manager.token)
          .expect(200),
      ).status,
    ).toBe('paid');
  });

  it('a second, different transaction on a paid checkout: recorded as credit and flagged', async () => {
    const s = await online('Webhook Double');
    await f.issue(s.manager, s.home.id);
    const { intention } = await checkout(s);
    await paid(s, intention).send().expect(200);
    await paid(s, intention).send().expect(200);
    expect(await paymentsOf(s)).toHaveLength(2);
    expect((await statement(s)).credit).toBe('1000.00');
    expect(
      (
        await auditReaders(h).security({ event: 'payment.duplicate_charge' })
      ).some((r) => r.tenantId === s.c.tenantId),
    ).toBe(true);
  });

  it('a wallet payment is recorded as wallet', async () => {
    const s = await online('Webhook Wallet');
    await f.issue(s.manager, s.home.id);
    const { intention } = await checkout(s);
    await paid(s, intention, {
      source_data: { pan: '01010', type: 'wallet', sub_type: 'wallet' },
    })
      .send()
      .expect(200);
    expect((await paymentsOf(s))[0].method).toBe('wallet');
  });

  it('a compound switched off by the platform still lands payments already made', async () => {
    const s = await online('Webhook Switched Off');
    await f.issue(s.manager, s.home.id);
    const { intention } = await checkout(s);
    const admin = await f.platformAdmin(true);
    await f
      .http(
        'patch',
        `/platform/tenants/${s.c.tenantId}/payment-gateway`,
        admin.token,
        {
          platformDisabled: true,
        },
      )
      .expect(200);
    await paid(s, intention).send().expect(200);
    expect(await paymentsOf(s)).toHaveLength(1);
  });
});
