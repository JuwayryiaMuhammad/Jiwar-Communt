import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { newId } from '../../src/core/common/uuid';
import { uniqueSuffix } from '../setup/fixtures';
import { day, vehicleHelpers, type Who } from '../setup/vehicles';

interface Payment {
  id: string;
  fineId: string;
  kind: string;
  amount: string | null;
  receiptNumber: string | null;
  paidOn: string | null;
  reversesId: string | null;
  reasonCode: string | null;
}

/**
 * ADR 0045: a fine is paid at the office (`fines.billing`, the accountant)
 * with append-only records: the whole amount, a receipt once in the
 * compound, a day in range. A wrong payment is reversed, once; the fine is
 * paid exactly while a payment without a reversal holds it, whatever
 * arrives at once.
 */
describe('Fines — payments at the office', () => {
  let h: HttpHarness;
  let v: ReturnType<typeof vehicleHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof vehicleHelpers>['setUp']>>;
  let accountant: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    v = vehicleHelpers(h);
    s = await v.setUp();
    accountant = await v.staff(s.c, ['fines.billing']);
  }, 120_000);

  afterAll(() => h.close());

  const receipt = () => `RC-${uniqueSuffix()}`;
  const pay = (
    fineId: string,
    over: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) =>
    v.http(
      'post',
      `/staff/vehicle-fines/${fineId}/payments`,
      accountant.token,
      { amount: '500', receiptNumber: receipt(), paidOn: day(0), ...over },
      headers,
    );
  const reverse = (paymentId: string, reasonCode = 'entered_in_error') =>
    v.http(
      'post',
      `/staff/vehicle-fine-payments/${paymentId}/reverse`,
      accountant.token,
      { reasonCode },
    );
  const status = async (fineId: string) =>
    (
      await v.inTx(s.c, (tx) =>
        tx.vehicleFine.findUniqueOrThrow({ where: { id: fineId } }),
      )
    ).status;
  const outcome = (res: { status: number; body: unknown }) => ({
    status: res.status,
    code: (res.body as { code?: string }).code,
  });

  it('the whole amount, a receipt and a day: the fine is paid; the payment shows on it', async () => {
    const fine = await v.fine(s.manager, s.home.code, { amount: '500' });
    const number = receipt();
    const res = await pay(fine.id, { amount: '500.00', receiptNumber: number });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      fineId: fine.id,
      kind: 'payment',
      amount: '500.00',
      currency: 'EGP',
      receiptNumber: number,
      paidOn: day(0),
    });
    expect(await status(fine.id)).toBe('paid');
    const staff = (
      await v
        .http('get', `/staff/vehicle-fines/${fine.id}`, accountant.token)
        .expect(200)
    ).body as { payments: (Payment & { recordedBy: { id: string } })[] };
    expect(staff.payments).toEqual([
      expect.objectContaining({
        kind: 'payment',
        recordedBy: {
          id: accountant.id,
          fullName: expect.any(String) as string,
        },
      }),
    ]);
    expect(outcome(await pay(fine.id))).toEqual({
      status: 409,
      code: 'FINE_NOT_PAYABLE',
    });
  });

  it('refuses a partial amount, a day out of range and a receipt used before', async () => {
    const fine = await v.fine(s.manager, s.home.code, {
      amount: '300',
      occurredOn: day(-2),
    });
    expect((await pay(fine.id, { amount: '200' })).body).toMatchObject({
      fields: [
        {
          field: 'amount',
          code: 'AMOUNT_MISMATCH',
          params: { amount: '300.00' },
        },
      ],
    });
    expect(
      (await pay(fine.id, { amount: '300', paidOn: day(-3) })).body,
    ).toMatchObject({
      fields: [
        {
          field: 'paidOn',
          code: 'PAID_ON_OUT_OF_RANGE',
          params: { min: day(-2), max: day(0) },
        },
      ],
    });
    expect((await pay(fine.id, { amount: '300', paidOn: day(1) })).status).toBe(
      400,
    );
    const used = receipt();
    const other = await v.fine(s.manager, s.home.code, { amount: '300' });
    await pay(other.id, { amount: '300', receiptNumber: used }).expect(201);
    expect(
      (await pay(fine.id, { amount: '300', receiptNumber: used })).body,
    ).toMatchObject({
      code: 'DUPLICATE_RESOURCE',
      fields: [{ field: 'receiptNumber', code: 'DUPLICATE_VALUE' }],
    });
    expect(await status(fine.id)).toBe('unpaid');
  });

  it('a fine under appeal is paid once decided; a cancelled one never', async () => {
    const appealed = await v.fine(s.manager, s.home.code);
    await v
      .http('post', `/vehicle-fines/${appealed.id}/appeal`, s.alice.token, {
        reason: 'Review',
      })
      .expect(200);
    expect(outcome(await pay(appealed.id))).toEqual({
      status: 409,
      code: 'FINE_UNDER_APPEAL',
    });
    const cancelled = await v.fine(s.manager, s.home.code);
    await v
      .http(
        'post',
        `/staff/vehicle-fines/${cancelled.id}/cancel`,
        s.manager.token,
        {
          reasonCode: 'duplicate',
        },
      )
      .expect(200);
    expect(outcome(await pay(cancelled.id))).toEqual({
      status: 409,
      code: 'FINE_NOT_PAYABLE',
    });
  });

  it('a reversal, once: the fine is unpaid again and takes a new payment', async () => {
    const fine = await v.fine(s.manager, s.home.code);
    const payment = (await pay(fine.id).expect(201)).body as Payment;
    const reversal = await reverse(payment.id, 'refunded').expect(201);
    expect(reversal.body).toMatchObject({
      kind: 'reversal',
      reversesId: payment.id,
      reasonCode: 'refunded',
      amount: null,
    });
    expect(await status(fine.id)).toBe('unpaid');
    expect(outcome(await reverse(payment.id))).toEqual({
      status: 409,
      code: 'FINE_PAYMENT_ALREADY_REVERSED',
    });
    expect(outcome(await reverse((reversal.body as Payment).id))).toEqual({
      status: 404,
      code: 'FINE_PAYMENT_NOT_FOUND',
    });
    await pay(fine.id).expect(201);
    expect(await status(fine.id)).toBe('paid');
  });

  it('records are append-only: the app cannot change or delete one', async () => {
    const fine = await v.fine(s.manager, s.home.code);
    const payment = (await pay(fine.id).expect(201)).body as Payment;
    await expect(
      v.inTx(s.c, (tx) =>
        tx.vehicleFinePayment.update({
          where: { id: payment.id },
          data: { receiptNumber: 'CHANGED' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      v.inTx(s.c, (tx) =>
        tx.vehicleFinePayment.delete({ where: { id: payment.id } }),
      ),
    ).rejects.toThrow();
  });

  it('two payments of one fine at once: one is recorded, the fine paid once', async () => {
    for (let round = 0; round < 3; round++) {
      const fine = await v.fine(s.manager, s.home.code);
      const results = await Promise.all([
        pay(fine.id),
        pay(fine.id),
        pay(fine.id),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(
        await v.inTx(s.c, (tx) =>
          tx.vehicleFinePayment.count({
            where: { fineId: fine.id, kind: 'payment' },
          }),
        ),
      ).toBe(1);
      expect(await status(fine.id)).toBe('paid');
    }
  });

  it('two reversals of one payment at once: one', async () => {
    const fine = await v.fine(s.manager, s.home.code);
    const payment = (await pay(fine.id).expect(201)).body as Payment;
    const results = await Promise.all([
      reverse(payment.id),
      reverse(payment.id),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await status(fine.id)).toBe('unpaid');
  });

  it('the same Idempotency-Key twice at once records one payment', async () => {
    const fine = await v.fine(s.manager, s.home.code);
    const key = newId();
    const body = { amount: '500', receiptNumber: receipt(), paidOn: day(0) };
    const [a, b] = await Promise.all([
      pay(fine.id, body, { 'Idempotency-Key': key }),
      pay(fine.id, body, { 'Idempotency-Key': key }),
    ]);
    expect([a.status, b.status]).toContain(201);
    expect(
      await v.inTx(s.c, (tx) =>
        tx.vehicleFinePayment.count({ where: { fineId: fine.id } }),
      ),
    ).toBe(1);
  });

  it('only fines.billing records payments: the issuer does not', async () => {
    const issuer = await v.staff(s.c, ['fines.issue']);
    const fine = await v.fine(issuer, s.home.code);
    expect(
      outcome(
        await v.http(
          'post',
          `/staff/vehicle-fines/${fine.id}/payments`,
          issuer.token,
          {
            amount: '500',
            receiptNumber: receipt(),
            paidOn: day(0),
          },
        ),
      ),
    ).toEqual({ status: 403, code: 'FORBIDDEN' });
  });
});
