import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { financeHelpers } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { FakePaymob } from '../setup/paymob-fake';

/**
 * Opening at the same time (ADR 0046): four first requests for one unit
 * make one checkout and ask Paymob once; the others reuse it or are told
 * it is being opened. Never two live checkouts.
 */
describe('Finance — session dedupe (races)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  const paymob = new FakePaymob();

  beforeAll(async () => {
    h = await createHttpHarness({ paymob });
    f = financeHelpers(h);
  });

  afterAll(() => h.close());

  it('four at once: one intention, one live checkout', async () => {
    const s = await f.setUp('Dedupe Court');
    await f.configureGateway(s.manager);
    await f.issue(s.manager, s.home.id);
    const before = paymob.created.length;
    const answers = await Promise.all(
      [0, 1, 2, 3].map(() =>
        f.http(
          'post',
          `/units/${s.home.id}/payment-sessions`,
          s.owner.token,
          {},
        ),
      ),
    );
    for (const r of answers) {
      expect([201, 409]).toContain(r.status);
      if (r.status === 409)
        expect((r.body as { code: string }).code).toBe(
          'PAYMENT_SESSION_IN_FLIGHT',
        );
    }
    const ids = new Set(
      answers
        .filter((r) => r.status === 201)
        .map((r) => (r.body as { id: string }).id),
    );
    expect(ids.size).toBe(1);
    expect(paymob.created.length - before).toBe(1);
    const live = await f.x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        tx.paymentSession.count({
          where: { unitId: s.home.id, status: { in: ['opening', 'open'] } },
        }),
      ),
    );
    expect(live).toBe(1);
  });

  it('two payers of one unit at once: one live checkout; the later supersedes the earlier', async () => {
    const s = await f.setUp('Dedupe Two Payers');
    await f.configureGateway(s.manager);
    const member = await f.family(s.c, s.home.id, s.owner);
    await f.grantFinance(s.c, s.owner, member.memberId, '50000');
    await f.issue(s.manager, s.home.id);
    const answers = await Promise.all([
      f.http('post', `/units/${s.home.id}/payment-sessions`, s.owner.token, {}),
      f.http('post', `/units/${s.home.id}/payment-sessions`, member.token, {}),
    ]);
    expect(answers.some((r) => r.status === 201)).toBe(true);
    const live = await f.x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        tx.paymentSession.count({
          where: { unitId: s.home.id, status: { in: ['opening', 'open'] } },
        }),
      ),
    );
    expect(live).toBe(1);
  });
});
