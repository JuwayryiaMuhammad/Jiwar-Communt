import { err } from '../api/request';
import { day } from '../setup/compound-clock';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0069: a payment's receipt as a PDF — drawn on demand, never stored,
 * the same page for the same payment; for whoever sees the unit's money
 * and the staff who keep payments; not cached.
 */
describe('Finance — a receipt as a PDF', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;
  let paymentId: string;
  let receiptNumber: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    s = await f.setUp('Receipt Court');
    await f.issue(s.accountant, s.home.id);
    const paid = (
      await f
        .http(
          'post',
          `/staff/units/${s.home.id}/payments`,
          s.accountant.token,
          {
            amount: '1000',
            method: 'cash',
            paidOn: day(0),
          },
        )
        .expect(201)
    ).body as { id: string; receiptNumber: string };
    paymentId = paid.id;
    receiptNumber = paid.receiptNumber;
  }, 90_000);

  afterAll(() => h.close());

  const pdf = (path: string, token: string) =>
    f
      .http('get', path, token)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });

  it('a PDF named by its receipt number, not cached, the same bytes twice', async () => {
    const first = await pdf(
      `/payments/${paymentId}/receipt`,
      s.owner.token,
    ).expect(200);
    expect(first.headers['content-type']).toBe('application/pdf');
    expect(first.headers['content-disposition']).toBe(
      `attachment; filename="${receiptNumber}.pdf"`,
    );
    expect(first.headers['cache-control']).toBe('no-store');
    const body = first.body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    const again = await pdf(
      `/payments/${paymentId}/receipt`,
      s.owner.token,
    ).expect(200);
    expect((again.body as Buffer).equals(body)).toBe(true);
    // The staff's copy is the same page.
    const staff = await pdf(
      `/staff/payments/${paymentId}/receipt`,
      s.accountant.token,
    ).expect(200);
    expect((staff.body as Buffer).equals(body)).toBe(true);
  });

  it('who: whoever sees the unit’s money; anyone else finds no payment', async () => {
    const stranger = await f.owner(s.c, (await f.unit(s.c, 'B')).id);
    expect(
      err(
        await f
          .http('get', `/payments/${paymentId}/receipt`, stranger.token)
          .expect(404),
      ).code,
    ).toBe('PAYMENT_NOT_FOUND');
    const member = await f.family(s.c, s.home.id, s.owner);
    await f
      .http('get', `/payments/${paymentId}/receipt`, member.token)
      .expect(404);
    await f.grantFinance(s.c, s.owner, member.memberId);
    await pdf(`/payments/${paymentId}/receipt`, member.token).expect(200);
    await f
      .http('get', `/staff/payments/${paymentId}/receipt`, s.owner.token)
      .expect(403);
  });
});
