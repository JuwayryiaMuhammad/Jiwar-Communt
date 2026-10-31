import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { R11C1B_COVERAGE } from '../setup/audit-coverage-split';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
  type Who,
} from '../setup/facilities';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { vehicleHelpers } from '../setup/vehicles';

/**
 * One scenario per entry of booking extras' and charges' catalog (ADR 0014,
 * 0070): actor, target and metadata — codes, ids, amounts and counts,
 * never a name or the staff's words.
 */
const covered = new Set<string>();

describe('Audit coverage — booking extras and charges', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: FacilitiesSetUp;
  let accountant: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    read = auditReaders(h);
    s = await f.setUp();
    accountant = await f.accountant(s.c);
  }, 180_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  describe('charges', () => {
    it('finance_charge.raised, .paid and .cancelled — the source, the invoice, the amount and the codes', async () => {
      const court = await f.facility(s.c, s.manager, {
        weeklyQuota: 20,
        feeAmount: '80.00',
      });
      const b = await f.book(s.alice, s.homeA.id, court, at(day(5), 10));
      const charge = await f.inTx(s.c, (tx) =>
        tx.financeCharge.findFirstOrThrow({
          where: { source: 'booking', sourceId: b.id },
        }),
      );
      const raised = await single('finance_charge.raised', charge.id);
      expect(raised).toMatchObject({
        actorId: s.alice.id,
        metadata: {
          source: 'booking',
          sourceId: b.id,
          unitId: s.homeA.id,
          invoiceId: charge.invoiceId,
          number: expect.any(String) as string,
          kind: 'facility',
          amount: '80.00',
        },
      });

      await f
        .http('post', `/staff/units/${s.homeA.id}/payments`, accountant.token, {
          amount: '80.00',
          method: 'cash',
          paidOn: day(0),
          invoiceIds: [charge.invoiceId],
        })
        .expect(201);
      expect(await single('finance_charge.paid', charge.id)).toMatchObject({
        actorId: accountant.id,
        metadata: {
          source: 'booking',
          sourceId: b.id,
          unitId: s.homeA.id,
          invoiceId: charge.invoiceId,
          amount: '80.00',
        },
      });

      await f
        .http('post', `/staff/bookings/${b.id}/cancel`, s.handler.token, {
          reasonCode: 'facility_unavailable',
        })
        .expect(204);
      const cancelled = await single('finance_charge.cancelled', charge.id);
      expect(cancelled).toMatchObject({
        actorId: s.handler.id,
        metadata: {
          source: 'booking',
          sourceId: b.id,
          unitId: s.homeA.id,
          invoiceId: charge.invoiceId,
          reasonCode: 'booking_cancelled',
          creditNoteId: expect.any(String) as string,
          credited: '80.00',
          released: '80.00',
        },
      });
    });
  });

  describe('club membership requests', () => {
    it('club_membership_request.created, .paid and .cancelled — the unit, the plan, the charge and the codes', async () => {
      const planId = await f.plan(s.c, s.manager, { price: '120' });
      const ask = async () =>
        (
          await f
            .http(
              'post',
              `/units/${s.homeB.id}/club-membership/requests`,
              s.bob.token,
              { planId },
            )
            .expect(201)
        ).body as {
          id: string;
          charge: { invoiceId: string };
        };
      const paid = await ask();
      const created = await single('club_membership_request.created', paid.id);
      expect(created).toMatchObject({
        actorId: s.bob.id,
        metadata: {
          unitId: s.homeB.id,
          planId,
          amount: '120.00',
          chargeId: expect.any(String) as string,
          invoiceId: paid.charge.invoiceId,
        },
      });
      await f
        .http('post', `/staff/units/${s.homeB.id}/payments`, accountant.token, {
          amount: '120.00',
          method: 'cash',
          paidOn: day(0),
          invoiceIds: [paid.charge.invoiceId],
        })
        .expect(201);
      const row = await single('club_membership_request.paid', paid.id);
      expect(row).toMatchObject({
        actorId: accountant.id,
        metadata: {
          unitId: s.homeB.id,
          planId,
          membershipId: expect.any(String) as string,
          paymentId: expect.any(String) as string,
          periodStartsOn: day(0),
          periodEndsOn: expect.any(String) as string,
          membershipCreated: true,
        },
      });

      const called = await ask();
      await f
        .http(
          'post',
          `/club-membership-requests/${called.id}/cancel`,
          s.bob.token,
          { reasonCode: 'wrong_plan' },
        )
        .expect(200);
      expect(
        await single('club_membership_request.cancelled', called.id),
      ).toMatchObject({
        actorId: s.bob.id,
        metadata: {
          unitId: s.homeB.id,
          reasonCode: 'wrong_plan',
          chargeStatus: 'cancelled',
        },
      });
    });
  });

  describe('fines through finance', () => {
    it('vehicle_fine.paid, finance_charge.reopened and vehicle_fine.reopened — paid as its invoice, then the payment reversed', async () => {
      // A home of its own: no credit from the scenarios above pays it first.
      const home = await f.unit(s.c, 'C');
      const fine = await vehicleHelpers(h).fine(s.manager, home.code, {
        amount: '200',
      });
      const charge = await f.inTx(s.c, (tx) =>
        tx.financeCharge.findFirstOrThrow({
          where: { source: 'vehicle_fine', sourceId: fine.id },
        }),
      );
      const payment = (
        await f
          .http('post', `/staff/units/${home.id}/payments`, accountant.token, {
            amount: '200.00',
            method: 'cash',
            paidOn: day(0),
            invoiceIds: [charge.invoiceId],
          })
          .expect(201)
      ).body as { id: string };
      expect(await single('vehicle_fine.paid', fine.id)).toMatchObject({
        actorId: accountant.id,
        metadata: {
          unitId: home.id,
          chargeId: charge.id,
          invoiceId: charge.invoiceId,
          amount: '200.00',
        },
      });
      await f
        .http(
          'post',
          `/staff/payments/${payment.id}/reverse`,
          accountant.token,
          {
            reasonCode: 'entered_in_error',
          },
        )
        .expect(201);
      expect(await single('finance_charge.reopened', charge.id)).toMatchObject({
        actorId: accountant.id,
        metadata: {
          source: 'vehicle_fine',
          sourceId: fine.id,
          unitId: home.id,
          invoiceId: charge.invoiceId,
        },
      });
      expect(await single('vehicle_fine.reopened', fine.id)).toMatchObject({
        actorId: accountant.id,
        metadata: { unitId: home.id },
      });
    });
  });

  describe('companions', () => {
    it('booking_companion.* and booking.share_link_rotated — the booking and the unit, a removal’s code; never the token', async () => {
      const hall = await f.facility(s.c, s.manager, {
        maxGuests: 3,
        weeklyQuota: 20,
      });
      const b = await f.book(s.alice, s.homeA.id, hall, at(day(6), 10));
      const meta = { bookingId: b.id, unitId: s.homeA.id };
      const kid = await f.family(s.c, s.homeA.id, s.alice);
      const ask = async () =>
        (
          (
            await f
              .http('post', `/bookings/${b.id}/companions`, s.alice.token, {
                memberId: kid.memberId,
              })
              .expect(201)
          ).body as { companion: { id: string } }
        ).companion.id;
      const first = await ask();
      expect(await single('booking_companion.invited', first)).toMatchObject({
        actorId: s.alice.id,
        metadata: meta,
      });
      await f
        .http('post', `/me/companion-bookings/${first}/decline`, kid.token)
        .expect(200);
      expect(await single('booking_companion.declined', first)).toMatchObject({
        actorId: kid.id,
        metadata: meta,
      });
      const second = await ask();
      await f
        .http('post', `/me/companion-bookings/${second}/accept`, kid.token)
        .expect(200);
      expect(await single('booking_companion.accepted', second)).toMatchObject({
        actorId: kid.id,
        metadata: meta,
      });
      await f
        .http(
          'delete',
          `/bookings/${b.id}/companions/${second}?reasonCode=misconduct`,
          s.alice.token,
        )
        .expect(200);
      expect(await single('booking_companion.removed', second)).toMatchObject({
        actorId: s.alice.id,
        metadata: { ...meta, reasonCode: 'misconduct' },
      });

      const { token } = (
        await f
          .http('post', `/bookings/${b.id}/share-link`, s.alice.token)
          .expect(201)
      ).body as { token: string };
      const rotated = await single('booking.share_link_rotated', b.id);
      expect(rotated).toMatchObject({
        actorId: s.alice.id,
        metadata: { unitId: s.homeA.id },
      });
      expect(JSON.stringify(rotated)).not.toContain(token);
      const joined = (
        (
          await f
            .http('post', '/booking-invites/accept', s.bob.token, { token })
            .expect(201)
        ).body as { companion: { id: string } }
      ).companion.id;
      expect(await single('booking_companion.joined', joined)).toMatchObject({
        actorId: s.bob.id,
        metadata: meta,
      });
      await f
        .http('post', `/bookings/${b.id}/companions/me/leave`, s.bob.token)
        .expect(200);
      expect(await single('booking_companion.left', joined)).toMatchObject({
        actorId: s.bob.id,
        metadata: meta,
      });
    });
  });

  describe('catalog completeness', () => {
    it('every entry of booking extras and charges has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of R11C1B_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...R11C1B_COVERAGE].sort());
    });
  });
});
