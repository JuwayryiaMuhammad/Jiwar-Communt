import { err } from '../api/request';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
  type Who,
} from '../setup/facilities';

interface Charge {
  invoiceId: string;
  amount: string;
  status: 'open' | 'paid' | 'cancelled';
}

/**
 * ADR 0070: a facility may charge for its bookings — a fee, another at
 * peak times — owed through an invoice of the unit's that the charges
 * port raises when a booking is confirmed (at once, or at the staff's
 * approval). A resident who cancels before the facility's refund cutoff is
 * credited in full, later not; the staff, a closure, a ban or the system
 * always credit it. A charge's invoice is never split or disputed.
 */
describe('Bookings: fees through finance (ADR 0070)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;
  let accountant: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
    accountant = await f.accountant(s.c);
  }, 180_000);

  afterAll(() => h.close());

  const paying = (over: Record<string, unknown> = {}) =>
    f.facility(s.c, s.manager, {
      weeklyQuota: 20,
      capacity: 5,
      feeAmount: '150.00',
      ...over,
    });
  const chargeOf = (bookingId: string) =>
    f.inTx(s.c, (tx) =>
      tx.financeCharge.findFirst({
        where: { source: 'booking', sourceId: bookingId },
      }),
    );
  const invoice = async (id: string) =>
    (await f.http('get', `/staff/invoices/${id}`, s.manager.token).expect(200))
      .body as {
      kind: string;
      total: string;
      status: string;
      outstanding: string;
      dueOn: string;
    };
  const charge = async (bookingId: string, as: Who = s.alice) =>
    (
      (await f.http('get', `/bookings/${bookingId}`, as.token).expect(200))
        .body as { charge: Charge | null }
    ).charge;

  it('a confirmed booking of a paying facility owes its fee through a `facility` invoice, due on its day', async () => {
    const court = await paying();
    const b = await f.book(s.alice, s.homeA.id, court, at(day(3), 10));
    const c = await charge(b.id);
    expect(c).toEqual({
      invoiceId: expect.any(String) as string,
      amount: '150.00',
      status: 'open',
    });
    expect(await invoice(c!.invoiceId)).toMatchObject({
      kind: 'facility',
      total: '150.00',
      outstanding: '150.00',
      dueOn: day(3),
    });
    // A free facility raises nothing, as before.
    const free = await f.facility(s.c, s.manager, { weeklyQuota: 20 });
    expect(
      await charge(
        (await f.book(s.alice, s.homeA.id, free, at(day(3), 10))).id,
      ),
    ).toBeNull();
  });

  it('a peak slot owes the peak fee', async () => {
    const court = await paying({ peakFeeAmount: '220.50' });
    await f
      .http('put', `/staff/facilities/${court}/peak-windows`, s.manager.token, {
        windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          startMinute: 1080,
          endMinute: 1260,
        })),
      })
      .expect(200);
    const peak = await f.book(s.bob, s.homeB.id, court, at(day(4), 19));
    const off = await f.book(s.bob, s.homeB.id, court, at(day(4), 9));
    expect((await charge(peak.id, s.bob))?.amount).toBe('220.50');
    expect((await charge(off.id, s.bob))?.amount).toBe('150.00');
  });

  it('a booking waiting for approval owes nothing until approved; a rejected one never does', async () => {
    const hall = await paying({ requiresApproval: true });
    const a = await f.book(s.alice, s.homeA.id, hall, at(day(5), 10));
    expect(await chargeOf(a.id)).toBeNull();
    await f
      .http('post', `/staff/bookings/${a.id}/approve`, s.handler.token)
      .expect(204);
    expect((await charge(a.id))?.status).toBe('open');
    const b = await f.book(s.alice, s.homeA.id, hall, at(day(5), 12));
    await f
      .http('post', `/staff/bookings/${b.id}/reject`, s.handler.token, {
        reasonCode: 'slot_unavailable',
      })
      .expect(204);
    expect(await chargeOf(b.id)).toBeNull();
  });

  it('cancelled by the resident before the refund cutoff: credited in full by a `charge_cancelled` credit note', async () => {
    const court = await paying({ refundCutoffHours: 24 });
    const b = await f.book(s.alice, s.homeA.id, court, at(day(4), 10));
    const { invoiceId } = (await charge(b.id))!;
    await f.cancel(s.alice, b.id).expect(204);
    expect(await chargeOf(b.id)).toMatchObject({
      cancelReason: 'booking_cancelled',
      cancelledAt: expect.any(Date) as Date,
    });
    expect(await invoice(invoiceId)).toMatchObject({
      status: 'credited',
      outstanding: '0.00',
    });
    const notes = await f.inTx(s.c, (tx) =>
      tx.creditNote.findMany({ where: { invoiceId } }),
    );
    expect(notes).toEqual([
      expect.objectContaining({
        reasonCode: 'charge_cancelled',
        createdById: s.alice.id,
      }),
    ]);
  });

  it('cancelled by the resident after the cutoff: the fee stays owed', async () => {
    const court = await paying({ refundCutoffHours: 168 });
    const b = await f.book(s.alice, s.homeA.id, court, at(day(3), 10));
    const { invoiceId } = (await charge(b.id))!;
    await f.cancel(s.alice, b.id).expect(204);
    expect((await f.row(s.c, b.id)).status).toBe('cancelled');
    expect((await charge(b.id))?.status).toBe('open');
    expect((await invoice(invoiceId)).outstanding).toBe('150.00');
  });

  it('paid, then cancelled by the staff: the money is the unit’s credit', async () => {
    const court = await paying();
    const b = await f.book(s.bob, s.homeB.id, court, at(day(6), 10));
    const { invoiceId } = (await charge(b.id, s.bob))!;
    await f
      .http('post', `/staff/units/${s.homeB.id}/payments`, accountant.token, {
        amount: '150.00',
        method: 'cash',
        paidOn: day(0),
        invoiceIds: [invoiceId],
      })
      .expect(201);
    expect((await charge(b.id, s.bob))?.status).toBe('paid');
    await f
      .http('post', `/staff/bookings/${b.id}/cancel`, s.handler.token, {
        reasonCode: 'facility_unavailable',
      })
      .expect(204);
    expect((await charge(b.id, s.bob))?.status).toBe('cancelled');
    const credited = await f.inTx(s.c, (tx) =>
      tx.financeAllocationRelease.aggregate({
        where: { allocation: { invoiceId } },
        _sum: { amount: true },
      }),
    );
    expect(credited._sum.amount?.toFixed(2)).toBe('150.00');
  });

  it('a closure credits the fees of what it cancels, as `closure`', async () => {
    const court = await paying();
    const b = await f.book(s.alice, s.homeA.id, court, at(day(8), 10));
    const window = {
      startsAt: at(day(8), 9).toISOString(),
      endsAt: at(day(8), 12).toISOString(),
    };
    // A fee at stake: previewed first (ADR 0084).
    const { previewToken } = (
      await f
        .http(
          'get',
          `/staff/facilities/${court}/closure-preview?${new URLSearchParams(window).toString()}`,
          s.manager.token,
        )
        .expect(200)
    ).body as { previewToken: string };
    await f
      .http('post', `/staff/facilities/${court}/closures`, s.manager.token, {
        ...window,
        reasonCode: 'weather',
        previewToken,
      })
      .expect(201);
    expect(await chargeOf(b.id)).toMatchObject({ cancelReason: 'closure' });
  });

  it('a walk-in facility takes no fee; the staff never issue a charge’s kind', async () => {
    const res = await f.http('post', '/staff/facilities', s.manager.token, {
      mode: 'walk_in',
      nameEn: 'Pool',
      nameAr: 'حمام سباحة',
      feeAmount: '10',
    });
    expect(res.status).toBe(400);
    expect(err(res).fields).toEqual([
      { field: 'feeAmount', code: 'FIELD_NOT_ALLOWED' },
    ]);
    const issued = await f.http('post', '/staff/invoices', s.manager.token, {
      target: 'unit',
      unitId: s.homeA.id,
      kind: 'facility',
      dueOn: day(10),
      lines: [{ descriptionEn: 'x', descriptionAr: 'x', amount: '10' }],
    });
    expect(issued.status).toBe(400);
    expect(err(issued).fields).toEqual([
      { field: 'kind', code: 'INVALID_VALUE' },
    ]);
  });

  it('a charge’s invoice is neither split into instalments nor disputed', async () => {
    const court = await paying();
    const b = await f.book(s.alice, s.homeA.id, court, at(day(9), 10));
    const { invoiceId } = (await charge(b.id))!;
    const split = await f.http(
      'post',
      `/staff/invoices/${invoiceId}/instalment-plan`,
      s.manager.token,
      {
        instalments: [
          { dueOn: day(10), amount: '75.00' },
          { dueOn: day(20), amount: '75.00' },
        ],
      },
    );
    expect(split.status).toBe(409);
    expect(err(split)).toMatchObject({
      code: 'INVOICE_NOT_CONVERTIBLE',
      params: { reason: 'charge' },
    });
    const disputed = await f.http(
      'post',
      `/invoices/${invoiceId}/disputes`,
      s.alice.token,
      { reasonCode: 'wrong_amount' },
    );
    expect(disputed.status).toBe(409);
    expect(err(disputed)).toMatchObject({
      code: 'INVOICE_NOT_DISPUTABLE',
      params: { reason: 'charge' },
    });
  });
});
