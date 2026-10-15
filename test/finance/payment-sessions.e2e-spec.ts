import type { Response } from 'supertest';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { SESSION_EXPIRY_SWEEP } from '../../src/finance/online/payment-sessions.service';
import { day } from '../setup/facilities';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { FakePaymob } from '../setup/paymob-fake';

const body = <T>(res: Response) => res.body as T;
const code = (res: Response) => body<{ code: string }>(res).code;

interface SessionBody {
  id: string;
  status: string;
  amount: string;
  invoices: { invoiceId: string; number: string; amount: string }[];
  checkoutUrl: string | null;
  payment: unknown;
}

/**
 * Opening a checkout (ADR 0046): who may pay, what, through which compound
 * account; one live checkout per unit, reused for the same basket, the
 * client secret sealed; the staff's changes make it stale.
 */
describe('Finance — payment sessions', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  const paymob = new FakePaymob();

  beforeAll(async () => {
    h = await createHttpHarness({ paymob });
    f = financeHelpers(h);
  });

  afterAll(() => h.close());

  const open = (
    who: { token: string },
    unitId: string,
    invoiceIds?: string[],
  ) =>
    f.http('post', `/units/${unitId}/payment-sessions`, who.token, {
      ...(invoiceIds ? { invoiceIds } : {}),
    });
  async function online(name: string) {
    const s = await f.setUp(name);
    const creds = await f.configureGateway(s.manager);
    return { ...s, creds };
  }
  const sessionRow = (s: FinanceSetUp, id: string) =>
    f.x.asManager(s.c, () =>
      h.moduleRef
        .get(TenantTx)
        .withTenantTx((tx) =>
          tx.paymentSession.findUniqueOrThrow({ where: { id } }),
        ),
    );

  it('opens a hosted checkout for everything owed: Paymob is asked once, the secret is sealed', async () => {
    const s = await online('Sessions Open');
    const a = await f.issue(s.manager, s.home.id, { dueOn: day(3) });
    const b = await f.issue(s.manager, s.home.id, { dueOn: day(9) });
    const res = await open(s.owner, s.home.id).expect(201);
    const session = body<SessionBody>(res);
    expect(session).toMatchObject({
      status: 'open',
      amount: '2000.00',
      payment: null,
    });
    expect(session.invoices.map((i) => i.invoiceId)).toEqual([
      a.invoiceId,
      b.invoiceId,
    ]);
    const intention = paymob.byReference(`jw-${session.id}`);
    expect(session.checkoutUrl).toBe(
      `https://paymob.invalid/unifiedcheckout/?publicKey=${s.creds.publicKey}&clientSecret=${intention.clientSecret}`,
    );
    const sent = paymob.requests.find(
      (r) =>
        r.method === 'POST' &&
        (r.body as { special_reference: string }).special_reference ===
          `jw-${session.id}`,
    )!;
    expect(sent.headers.Authorization).toBe(`Token ${s.creds.secretKey}`);
    expect(sent.body).toMatchObject({
      amount: 200000,
      currency: 'EGP',
      payment_methods: [4100001, 4100002],
      notification_url: `https://api.jiwar.test/api/v1/public/payments/paymob/${s.c.tenantId}`,
      redirection_url: 'https://app.jiwar.test/paid',
      expiration: 1800,
    });
    expect(
      JSON.stringify((sent.body as { billing_data: object }).billing_data),
    ).not.toMatch(/@jiwar|Finance/);
    const row = await sessionRow(s, session.id);
    expect(row.gatewayOrderId).toBe(String(intention.orderId));
    expect(Buffer.from(row.clientSecretEnc!).toString('latin1')).not.toContain(
      intention.clientSecret,
    );
    // Someone without a place on the unit: not found.
    expect(
      code(
        await f
          .http('get', `/payment-sessions/${session.id}`, s.manager.token)
          .expect(404),
      ),
    ).toBe('PAYMENT_SESSION_NOT_FOUND');
    // Another who sees the unit's money: the checkout, without its page.
    const member = await f.family(s.c, s.home.id, s.owner);
    await f.grantFinance(s.c, s.owner, member.memberId);
    const seen = body<SessionBody>(
      await f
        .http('get', `/payment-sessions/${session.id}`, member.token)
        .expect(200),
    );
    expect(seen).toMatchObject({
      id: session.id,
      status: 'open',
      checkoutUrl: null,
    });
  });

  it('the same basket by the same payer reuses it; another basket supersedes it', async () => {
    const s = await online('Sessions Reuse');
    const a = await f.issue(s.manager, s.home.id);
    const b = await f.issue(s.manager, s.home.id);
    const first = body<SessionBody>(await open(s.owner, s.home.id).expect(201));
    const again = body<SessionBody>(await open(s.owner, s.home.id).expect(201));
    expect(again.id).toBe(first.id);
    expect(again.checkoutUrl).toBe(first.checkoutUrl);
    const one = body<SessionBody>(
      await open(s.owner, s.home.id, [a.invoiceId]).expect(201),
    );
    expect(one.id).not.toBe(first.id);
    expect(one.amount).toBe('1000.00');
    expect((await sessionRow(s, first.id)).status).toBe('superseded');
    void b;
  });

  it('an office payment or a credit note makes the open checkout stale', async () => {
    const s = await online('Sessions Stale');
    const { invoiceId } = await f.issue(s.manager, s.home.id);
    const first = body<SessionBody>(await open(s.owner, s.home.id).expect(201));
    await f
      .http(
        'post',
        `/staff/invoices/${invoiceId}/credit-notes`,
        s.manager.token,
        {
          amount: '100',
          reasonCode: 'waiver',
        },
      )
      .expect(201);
    expect((await sessionRow(s, first.id)).status).toBe('superseded');
    const second = body<SessionBody>(
      await open(s.owner, s.home.id).expect(201),
    );
    expect(second.amount).toBe('900.00');
    await f
      .http('post', `/staff/units/${s.home.id}/payments`, s.accountant.token, {
        amount: '100',
        method: 'cash',
        paidOn: day(0),
      })
      .expect(201);
    expect((await sessionRow(s, second.id)).status).toBe('superseded');
  });

  it('who may pay: owners, landlords, tenants, members with the grant within their cap', async () => {
    const s = await online('Sessions Who');
    const rented = await f.unit(s.c, 'A');
    const landlord = await f.landlord(s.c, rented.id);
    const tenant = await f.tenant(s.c, rented.id);
    const member = await f.family(s.c, s.home.id, s.owner);
    const neighbour = await f.owner(s.c, (await f.unit(s.c, 'A')).id);
    await f.issue(s.manager, s.home.id);
    await f.issue(s.manager, rented.id);
    await open(landlord, rented.id).expect(201);
    await open(tenant, rented.id).expect(201);
    expect(code(await open(member, s.home.id).expect(403))).toBe('FORBIDDEN');
    await f.grantFinance(s.c, s.owner, member.memberId, '500');
    const capped = await open(member, s.home.id).expect(403);
    expect(code(capped)).toBe('FINANCE_CAP_EXCEEDED');
    expect(body<{ params: object }>(capped).params).toEqual({ cap: '500' });
    expect(code(await open(neighbour, s.home.id).expect(404))).toBe(
      'UNIT_NOT_FOUND',
    );
    await open(s.owner, s.home.id).expect(201);
  });

  it('nothing to pay, an invoice not payable, online payment off', async () => {
    const s = await online('Sessions Refused');
    expect(code(await open(s.owner, s.home.id).expect(409))).toBe(
      'NOTHING_TO_PAY',
    );
    const other = await f.setUp('Sessions Foreign');
    const foreign = await f.issue(other.manager, other.home.id);
    expect(
      code(await open(s.owner, s.home.id, [foreign.invoiceId]).expect(409)),
    ).toBe('INVOICE_NOT_PAYABLE');
    await f.issue(s.manager, s.home.id);
    await f.stepUp(s.manager.token);
    await f
      .http('patch', '/staff/finance/gateway', s.manager.token, {
        onlineEnabled: false,
      })
      .expect(200);
    expect(code(await open(s.owner, s.home.id).expect(409))).toBe(
      'ONLINE_PAYMENT_UNAVAILABLE',
    );
    // Never configured.
    await f.issue(other.manager, other.home.id);
    expect(code(await open(other.owner, other.home.id).expect(409))).toBe(
      'ONLINE_PAYMENT_UNAVAILABLE',
    );
    // Switched off by the platform.
    await f.stepUp(s.manager.token);
    await f
      .http('patch', '/staff/finance/gateway', s.manager.token, {
        onlineEnabled: true,
      })
      .expect(200);
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
    expect(code(await open(s.owner, s.home.id).expect(409))).toBe(
      'ONLINE_PAYMENT_UNAVAILABLE',
    );
  });

  it('Paymob refusing or timing out: 502, the checkout failed, the next try opens a new one', async () => {
    const s = await online('Sessions Gateway Down');
    await f.issue(s.manager, s.home.id);
    paymob.failNextCreate = 503;
    const res = await open(s.owner, s.home.id).expect(502);
    expect(code(res)).toBe('PAYMENT_GATEWAY_ERROR');
    expect(body<{ params: object }>(res).params).toEqual({
      reason: 'unavailable',
    });
    paymob.failNextCreate = 'timeout';
    expect(
      body<{ params: object }>(await open(s.owner, s.home.id).expect(502))
        .params,
    ).toEqual({
      reason: 'timeout',
    });
    const ok = body<SessionBody>(await open(s.owner, s.home.id).expect(201));
    expect(ok.status).toBe('open');
    const failed = await f.x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        tx.paymentSession.count({
          where: { unitId: s.home.id, status: 'failed' },
        }),
      ),
    );
    expect(failed).toBe(2);
  });

  it('an open checkout past its time expires; its payer may poll it', async () => {
    const s = await online('Sessions Expiry');
    await f.issue(s.manager, s.home.id);
    const session = body<SessionBody>(
      await open(s.owner, s.home.id).expect(201),
    );
    await h.moduleRef
      .get(SweepRunner)
      .run(SESSION_EXPIRY_SWEEP, new Date(Date.now() + 31 * 60_000));
    const polled = body<SessionBody>(
      await f
        .http('get', `/payment-sessions/${session.id}`, s.owner.token)
        .expect(200),
    );
    expect(polled).toMatchObject({ status: 'expired', checkoutUrl: null });
  });

  it('an Idempotency-Key replays the checkout, rendered again (its secret is never stored)', async () => {
    const s = await online('Sessions Idem');
    await f.issue(s.manager, s.home.id);
    const key = `session-${Date.now()}`;
    const a = await open(s.owner, s.home.id)
      .set('Idempotency-Key', key)
      .expect(201);
    const b = await open(s.owner, s.home.id)
      .set('Idempotency-Key', key)
      .expect(201);
    expect(body<SessionBody>(b)).toEqual(body<SessionBody>(a));
    const stored = await f.x.asManager(s.c, () =>
      h.moduleRef
        .get(TenantTx)
        .withTenantTx((tx) =>
          tx.idempotencyKey.findFirstOrThrow({ where: { key } }),
        ),
    );
    expect(stored.responseBody).toBeNull();
  });
});
