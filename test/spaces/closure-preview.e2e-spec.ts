import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  spacesHelpers,
  type SpacesSetUp,
  type Who,
} from '../setup/spaces';

const code = (res: { body: unknown }) => (res.body as { code: string }).code;

/**
 * ADR 0084: a closure's preview — the bookings it would cancel and what
 * their fees become (an unpaid invoice credited, a paid fee the unit's
 * credit, ADR 0070's path) — and its token, without which a closure with a
 * fee at stake is refused, and with which it applies exactly what was
 * previewed or refuses: a booking landing in between, a fee paid in
 * between, or a second close of the same.
 */
describe('Facilities: a closure’s preview (ADR 0084)', () => {
  let h: HttpHarness;
  let sp: ReturnType<typeof spacesHelpers>;
  let s: SpacesSetUp;
  let accountant: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    sp = spacesHelpers(h);
    s = await sp.setUp('Closure Preview Court');
    accountant = await sp.accountant(s.c);
  }, 180_000);

  afterAll(() => h.close());

  const paying = () =>
    sp.facility(s.c, s.manager, {
      weeklyQuota: 20,
      capacity: 5,
      feeAmount: '150.00',
    });

  const payFor = async (who: Who, unitId: string, bookingId: string) => {
    const b = (
      await sp.http('get', `/bookings/${bookingId}`, who.token).expect(200)
    ).body as { charge: { invoiceId: string } };
    await sp
      .http('post', `/staff/units/${unitId}/payments`, accountant.token, {
        amount: '150.00',
        method: 'cash',
        paidOn: day(0),
        invoiceIds: [b.charge.invoiceId],
      })
      .expect(201);
  };

  it('shows the bookings it would cancel, each fee’s fate and the totals; a booking under way or outside is left out', async () => {
    const court = await paying();
    const unpaid = await sp.book(s.alice, s.homeA.id, court, at(day(4), 10));
    const paid = await sp.book(s.bob, s.homeB.id, court, at(day(4), 11));
    await payFor(s.bob, s.homeB.id, paid.id);
    await sp.book(s.bob, s.homeB.id, court, at(day(5), 11));
    const p = await sp.preview(s.manager, court, at(day(4), 9), at(day(4), 13));
    expect(p.bookings.map((b) => [b.id, b.unitCode, b.charge])).toEqual([
      [
        unpaid.id,
        s.homeA.code,
        { amount: '150.00', status: 'open', outcome: 'invoice_credited' },
      ],
      [
        paid.id,
        s.homeB.code,
        { amount: '150.00', status: 'paid', outcome: 'unit_credit' },
      ],
    ]);
    expect([p.invoicesCredited, p.unitCredit]).toEqual(['150.00', '150.00']);
    expect(p.previewToken).toMatch(/^[0-9a-f]{64}$/);
    // Nothing changed meanwhile: the same token, and nothing was written.
    expect(
      (await sp.preview(s.manager, court, at(day(4), 9), at(day(4), 13)))
        .previewToken,
    ).toBe(p.previewToken);
    expect((await sp.row(s.c, unpaid.id)).status).toBe('confirmed');
  });

  it('a fee at stake: refused without the preview; applied with it, crediting exactly what it showed', async () => {
    const court = await paying();
    const b = await sp.book(s.alice, s.homeA.id, court, at(day(6), 10));
    const without = await sp
      .close(s.manager, court, at(day(6), 9), at(day(6), 12))
      .expect(409);
    expect(code(without)).toBe('FACILITY_CLOSURE_PREVIEW_REQUIRED');
    const p = await sp.preview(s.manager, court, at(day(6), 9), at(day(6), 12));
    const res = await sp
      .close(s.manager, court, at(day(6), 9), at(day(6), 12), p.previewToken)
      .expect(201);
    expect((res.body as { cancelledBookings: number }).cancelledBookings).toBe(
      1,
    );
    expect((await sp.row(s.c, b.id)).status).toBe('cancelled');
    const audit = await sp.inTx(s.c, (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: {
          action: 'facility_closure.created',
          targetId: (res.body as { id: string }).id,
        },
      }),
    );
    expect(audit.metadata).toMatchObject({
      previewed: true,
      invoicesCredited: '150.00',
      unitCredit: '0.00',
    });
  });

  it('no fee at stake: closed without a preview, as before', async () => {
    const court = await sp.facility(s.c, s.manager);
    await sp.book(s.alice, s.homeA.id, court, at(day(7), 10));
    await sp.close(s.manager, court, at(day(7), 9), at(day(7), 12)).expect(201);
  });

  it('a booking made, or a fee paid, since the preview: refused as stale, nothing cancelled', async () => {
    const court = await paying();
    const b = await sp.book(s.alice, s.homeA.id, court, at(day(8), 10));
    const p = await sp.preview(s.manager, court, at(day(8), 9), at(day(8), 13));
    await sp.book(s.bob, s.homeB.id, court, at(day(8), 11));
    const landed = await sp
      .close(s.manager, court, at(day(8), 9), at(day(8), 13), p.previewToken)
      .expect(409);
    expect(code(landed)).toBe('FACILITY_CLOSURE_PREVIEW_STALE');
    const q = await sp.preview(s.manager, court, at(day(8), 9), at(day(8), 13));
    await payFor(s.alice, s.homeA.id, b.id);
    const paid = await sp
      .close(s.manager, court, at(day(8), 9), at(day(8), 13), q.previewToken)
      .expect(409);
    expect(code(paid)).toBe('FACILITY_CLOSURE_PREVIEW_STALE');
    expect((await sp.row(s.c, b.id)).status).toBe('confirmed');
    // Another window's token is not this one's.
    const other = await sp.preview(
      s.manager,
      court,
      at(day(8), 9),
      at(day(8), 14),
    );
    const shifted = await sp
      .close(
        s.manager,
        court,
        at(day(8), 9),
        at(day(8), 13),
        other.previewToken,
      )
      .expect(409);
    expect(code(shifted)).toBe('FACILITY_CLOSURE_PREVIEW_STALE');
  });

  it.each([1, 2, 3])(
    'round %i: the same preview closed twice at once — one closure, the other refused as stale',
    async (round) => {
      const court = await paying();
      await sp.book(s.alice, s.homeA.id, court, at(day(10 + round), 10));
      const p = await sp.preview(
        s.manager,
        court,
        at(day(10 + round), 9),
        at(day(10 + round), 12),
      );
      const both = await Promise.all([
        sp.close(
          s.manager,
          court,
          at(day(10 + round), 9),
          at(day(10 + round), 12),
          p.previewToken,
        ),
        sp.close(
          s.manager,
          court,
          at(day(10 + round), 9),
          at(day(10 + round), 12),
          p.previewToken,
        ),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(code(both.find((r) => r.status === 409)!)).toBe(
        'FACILITY_CLOSURE_PREVIEW_STALE',
      );
      expect(
        await sp.inTx(s.c, (tx) =>
          tx.facilityClosure.count({ where: { facilityId: court } }),
        ),
      ).toBe(1);
    },
  );

  it.each([1, 2, 3])(
    'round %i: a booking landing while the previewed closure is made — the closure refuses, or the booking waits and is refused',
    async (round) => {
      const court = await paying();
      await sp.book(s.alice, s.homeA.id, court, at(day(1 + round), 10));
      const p = await sp.preview(
        s.manager,
        court,
        at(day(1 + round), 9),
        at(day(1 + round), 12),
      );
      const [closed, booking] = await Promise.all([
        sp.close(
          s.manager,
          court,
          at(day(1 + round), 9),
          at(day(1 + round), 12),
          p.previewToken,
        ),
        sp.bookRaw(s.bob, s.homeB.id, court, at(day(1 + round), 11)),
      ]);
      if (closed.status === 201) {
        expect([booking.status, code(booking)]).toEqual([
          409,
          'FACILITY_CLOSED',
        ]);
      } else {
        expect(code(closed)).toBe('FACILITY_CLOSURE_PREVIEW_STALE');
        expect(booking.status).toBe(201);
      }
    },
  );
});
