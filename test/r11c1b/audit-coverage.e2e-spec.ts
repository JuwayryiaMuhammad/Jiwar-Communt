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

  describe('catalog completeness', () => {
    it('every entry of booking extras and charges has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of R11C1B_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...R11C1B_COVERAGE].sort());
    });
  });
});
