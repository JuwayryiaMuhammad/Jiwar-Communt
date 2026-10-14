import { addDays } from '../../src/core/common/slots/day-slots';
import { CLUB_EXPIRY_SWEEP } from '../../src/facilities/club/club.service';
import { addMonths } from '../../src/facilities/club/club-periods';
import { minorBody } from '../api/routes/household';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
  type Who,
} from '../setup/facilities';

interface MembershipBody {
  id: string;
  unitCode: string;
  state: string;
  activeThrough: string | null;
  people: {
    kind: string;
    id: string;
    fullName: string | null;
    isMinor: boolean;
  }[];
  payments: {
    id: string;
    kind: string;
    periodStartsOn: string;
    periodEndsOn: string;
    reversed: boolean;
  }[];
}

const fields = (res: { body: unknown }) =>
  (res.body as { fields: unknown[] }).fields;
const code = (res: { body: unknown }) => (res.body as { code: string }).code;

describe('The club: plans, memberships and offline payments (ADR 0044)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;
  let accountant: Who;
  let monthly: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
    accountant = await f.accountant(s.c);
    monthly = await f.plan(s.c, s.manager);
  }, 180_000);

  afterAll(() => h.close());

  const detail = async (id: string) =>
    (
      await f
        .http('get', `/staff/club-memberships/${id}`, accountant.token)
        .expect(200)
    ).body as MembershipBody;

  describe('plans', () => {
    it('the manager sets them up; a custom plan names its days, the others none; the accountant only reads them', async () => {
      const custom = await f.plan(s.c, s.manager, {
        nameEn: 'Summer',
        nameAr: 'صيفي',
        durationKind: 'custom',
        durationDays: 45,
        price: '1200.50',
      });
      expect(
        fields(
          await f
            .http('post', '/staff/club-plans', s.manager.token, {
              nameEn: 'X',
              nameAr: 'س',
              durationKind: 'custom',
              price: '10',
            })
            .expect(400),
        ),
      ).toEqual([{ field: 'durationDays', code: 'FIELD_REQUIRED' }]);
      expect(
        fields(
          await f
            .http('post', '/staff/club-plans', s.manager.token, {
              nameEn: 'X',
              nameAr: 'س',
              durationKind: 'annual',
              durationDays: 30,
              price: '10',
            })
            .expect(400),
        ),
      ).toEqual([{ field: 'durationDays', code: 'FIELD_NOT_ALLOWED' }]);
      await f
        .http('post', '/staff/club-plans', s.manager.token, {
          nameEn: 'X',
          nameAr: 'س',
          durationKind: 'annual',
          price: '0',
        })
        .expect(400);
      const list = (
        await f.http('get', '/staff/club-plans', accountant.token).expect(200)
      ).body as { data: { id: string; price: string }[] };
      expect(list.data.find((p) => p.id === custom)?.price).toBe('1200.50');
      await f
        .http('post', '/staff/club-plans', accountant.token, {
          nameEn: 'Y',
          nameAr: 'ص',
          durationKind: 'monthly',
          price: '1',
        })
        .expect(403);
      await f
        .http('patch', `/staff/club-plans/${custom}`, s.manager.token, {
          active: false,
        })
        .expect(200);
      const forResidents = (
        await f.http('get', '/club/plans', s.alice.token).expect(200)
      ).body as { data: { id: string }[] };
      expect(forResidents.data.map((p) => p.id)).toContain(monthly);
      expect(forResidents.data.map((p) => p.id)).not.toContain(custom);
    });
  });

  describe('a membership', () => {
    let unitId: string;
    let owner: Who;
    let member: Who & { memberId: string };
    let membershipId: string;

    beforeAll(async () => {
      const unit = await f.unit(s.c, 'M');
      unitId = unit.id;
      owner = await f.owner(s.c, unitId);
      member = await f.family(s.c, unitId, owner);
      await f
        .http(
          'post',
          `/units/${unitId}/household/minors`,
          owner.token,
          minorBody(),
        )
        .expect(201);
    }, 120_000);

    it('the accountant finds the unit by its code and sees its people by name, a minor too', async () => {
      const unit = await f.inTx(s.c, (tx) =>
        tx.unit.findUniqueOrThrow({ where: { id: unitId } }),
      );
      const found = await f
        .http(
          'get',
          `/staff/club/units?code=${encodeURIComponent(unit.code)}`,
          accountant.token,
        )
        .expect(200);
      expect(found.body).toEqual({
        id: unitId,
        code: unit.code,
        membershipId: null,
      });
      const people = await f.people(s.c, accountant, unitId);
      expect(people.map((p) => [p.kind, p.isMinor])).toEqual([
        ['occupancy', false],
        ['member', false],
        ['member', true],
      ]);
      expect(people.every((p) => typeof p.fullName === 'string')).toBe(true);
      await f
        .http(
          'get',
          `/staff/club/units?code=NOPE-${Date.now()}`,
          accountant.token,
        )
        .expect(404);
    });

    it('one per unit, covering the unit’s people only; inactive until a payment', async () => {
      const people = await f.people(s.c, accountant, unitId);
      const other = await f.people(s.c, accountant, s.homeA.id);
      const bad = await f
        .http('post', '/staff/club-memberships', accountant.token, {
          unitId,
          people: [{ occupancyId: other[0].id }],
        })
        .expect(400);
      expect(fields(bad)).toEqual([
        { field: 'people.0', code: 'PERSON_NOT_OF_UNIT' },
      ]);
      const res = await f
        .http('post', '/staff/club-memberships', accountant.token, {
          unitId,
          people: people
            .filter((p) => p.kind === 'occupancy' || p.isMinor)
            .map((p) =>
              p.kind === 'occupancy'
                ? { occupancyId: p.id }
                : { memberId: p.id },
            ),
        })
        .expect(201);
      membershipId = (res.body as { id: string }).id;
      expect(res.body).toMatchObject({
        state: 'none',
        activeThrough: null,
        payments: [],
      });
      expect((res.body as MembershipBody).people).toHaveLength(2);
      const again = await f
        .http('post', '/staff/club-memberships', accountant.token, {
          unitId,
          people: [],
        })
        .expect(409);
      expect(again.body).toMatchObject({
        code: 'CLUB_MEMBERSHIP_EXISTS',
        params: { membershipId },
      });
    });

    it('a payment activates it from the day paid; the next one chains after it; dates and plans are checked; a receipt is recorded once', async () => {
      const first = await f.pay(accountant, membershipId, monthly).expect(201);
      expect(first.body).toMatchObject({
        kind: 'payment',
        amount: '500.00',
        currency: 'EGP',
        paidOn: day(0),
        periodStartsOn: day(0),
        periodEndsOn: addMonths(day(0), 1),
      });
      let m = await detail(membershipId);
      expect(m).toMatchObject({
        state: 'active',
        activeThrough: addDays(addMonths(day(0), 1), -1),
      });
      const second = await f
        .pay(accountant, membershipId, monthly, { paidOn: day(-3) })
        .expect(201);
      expect(second.body).toMatchObject({
        periodStartsOn: addMonths(day(0), 1),
        periodEndsOn: addMonths(addMonths(day(0), 1), 1),
      });
      m = await detail(membershipId);
      expect(m.activeThrough).toBe(
        addDays(addMonths(addMonths(day(0), 1), 1), -1),
      );

      expect(
        fields(
          await f
            .pay(accountant, membershipId, monthly, { paidOn: day(1) })
            .expect(400),
        ),
      ).toEqual([
        {
          field: 'paidOn',
          code: 'PAID_ON_OUT_OF_RANGE',
          params: { min: day(-90), max: day(0) },
        },
      ]);
      await f
        .pay(accountant, membershipId, monthly, { paidOn: day(-91) })
        .expect(400);
      const retired = await f.plan(s.c, s.manager, { nameEn: 'Old' });
      await f
        .http('patch', `/staff/club-plans/${retired}`, s.manager.token, {
          active: false,
        })
        .expect(200);
      expect(
        fields(await f.pay(accountant, membershipId, retired).expect(400)),
      ).toEqual([{ field: 'planId', code: 'PLAN_NOT_AVAILABLE' }]);
      const receipt = (first.body as { receiptNumber: string }).receiptNumber;
      const dup = await f
        .pay(accountant, membershipId, monthly, { receiptNumber: receipt })
        .expect(409);
      expect(dup.body).toMatchObject({
        code: 'DUPLICATE_RESOURCE',
        fields: [{ field: 'receiptNumber', code: 'DUPLICATE_VALUE' }],
      });
      await f
        .pay(accountant, membershipId, monthly, { amount: '0.00' })
        .expect(400);
      await f
        .pay(accountant, membershipId, monthly, { currency: 'USD' })
        .expect(400);
    });

    it('a wrong payment is reversed once, by a new record; a reversal is not reversed; the records never change', async () => {
      const m = await detail(membershipId);
      const [, second] = m.payments;
      const res = await f
        .http(
          'post',
          `/staff/club-payments/${second.id}/reverse`,
          accountant.token,
          {
            reasonCode: 'entered_in_error',
          },
        )
        .expect(201);
      expect(res.body).toMatchObject({
        kind: 'reversal',
        reversesId: second.id,
        reasonCode: 'entered_in_error',
      });
      const after = await detail(membershipId);
      expect(after.activeThrough).toBe(addDays(addMonths(day(0), 1), -1));
      expect(after.payments.find((p) => p.id === second.id)?.reversed).toBe(
        true,
      );
      expect(
        code(
          await f
            .http(
              'post',
              `/staff/club-payments/${second.id}/reverse`,
              accountant.token,
              { reasonCode: 'other' },
            )
            .expect(409),
        ),
      ).toBe('CLUB_PAYMENT_ALREADY_REVERSED');
      expect(
        code(
          await f
            .http(
              'post',
              `/staff/club-payments/${(res.body as { id: string }).id}/reverse`,
              accountant.token,
              {
                reasonCode: 'other',
              },
            )
            .expect(404),
        ),
      ).toBe('CLUB_PAYMENT_NOT_FOUND');
      await expect(
        f.inTx(
          s.c,
          (tx) =>
            tx.$executeRaw`UPDATE club_payment_records SET amount = 1 WHERE id = ${second.id}::uuid`,
        ),
      ).rejects.toThrow(/permission denied|append-only/);
    });

    it('the unit’s people see it: first names, and its payments only with the unit’s money', async () => {
      const mine = (
        await f
          .http('get', `/units/${unitId}/club-membership`, owner.token)
          .expect(200)
      ).body as {
        membership: {
          state: string;
          people: { firstName: string | null; me: boolean }[];
          payments: unknown[] | null;
        };
      };
      expect(mine.membership.state).toBe('active');
      expect(mine.membership.people.map((p) => p.me)).toEqual([true, false]);
      expect(mine.membership.payments).toHaveLength(3);
      const theirs = (
        await f
          .http('get', `/units/${unitId}/club-membership`, member.token)
          .expect(200)
      ).body as { membership: { payments: unknown[] | null } };
      expect(theirs.membership.payments).toBeNull();
      await f
        .http('get', `/units/${unitId}/club-membership`, s.bob.token)
        .expect(404);
      const none = (
        await f
          .http('get', `/units/${s.homeB.id}/club-membership`, s.bob.token)
          .expect(200)
      ).body as { membership: unknown };
      expect(none.membership).toBeNull();
    });

    it('a facility for members: the unit’s membership is active on the slot’s day and covers the booker', async () => {
      const pool = await f.facility(s.c, s.manager, {
        requiresMembership: true,
        capacity: 10,
      });
      await f.book(owner, unitId, pool, at(day(2), 10));
      // The member is not covered.
      const notCovered = await f.bookRaw(member, unitId, pool, at(day(2), 11));
      expect([notCovered.status, code(notCovered)]).toEqual([
        403,
        'CLUB_MEMBERSHIP_REQUIRED',
      ]);
      // A unit without a membership.
      const noMembership = await f.bookRaw(
        s.bob,
        s.homeB.id,
        pool,
        at(day(2), 12),
      );
      expect([noMembership.status, code(noMembership)]).toEqual([
        403,
        'CLUB_MEMBERSHIP_REQUIRED',
      ]);
      // Covered from now on.
      const people = await f.people(s.c, accountant, unitId);
      await f
        .http(
          'put',
          `/staff/club-memberships/${membershipId}/people`,
          accountant.token,
          {
            people: people.map((p) =>
              p.kind === 'occupancy'
                ? { occupancyId: p.id }
                : { memberId: p.id },
            ),
          },
        )
        .expect(200);
      await f.book(member, unitId, pool, at(day(2), 11));
    });

    it('a week before it ends, the people it covers with an account are told, once', async () => {
      const unit = await f.unit(s.c, 'M');
      const holder = await f.owner(s.c, unit.id);
      const id = await f.membership(s.c, accountant, unit.id);
      await f
        .pay(accountant, id, monthly, {
          paidOn: addDays(addMonths(day(0), -1), 5),
        })
        .expect(201);
      expect((await detail(id)).state).toBe('expiring');
      await f.sweep(CLUB_EXPIRY_SWEEP);
      await f.sweep(CLUB_EXPIRY_SWEEP);
      expect(
        await f.notifications(s.c, holder.id, 'club_membership.expiring'),
      ).toHaveLength(1);
    });
  });

  describe('under concurrency', () => {
    it('two payments at once chain, never overlap; one receipt twice at once is recorded once; one reversal twice at once is made once', async () => {
      const unit = await f.unit(s.c, 'M');
      await f.owner(s.c, unit.id);
      const id = await f.membership(s.c, accountant, unit.id);
      const results = await Promise.all([
        f.pay(accountant, id, monthly),
        f.pay(s.manager, id, monthly),
      ]);
      expect(results.map((r) => r.status)).toEqual([201, 201]);
      const periods = results
        .map((r) => r.body as { periodStartsOn: string; periodEndsOn: string })
        .sort((a, b) => a.periodStartsOn.localeCompare(b.periodStartsOn));
      expect(periods[1].periodStartsOn).toBe(periods[0].periodEndsOn);

      const receipt = `R-RACE-${Date.now()}`;
      const twice = await Promise.all([
        f.pay(accountant, id, monthly, { receiptNumber: receipt }),
        f.pay(s.manager, id, monthly, { receiptNumber: receipt }),
      ]);
      expect(twice.map((r) => r.status).sort()).toEqual([201, 409]);

      const target = (results[0].body as { id: string }).id;
      const reversals = await Promise.all([
        f.http(
          'post',
          `/staff/club-payments/${target}/reverse`,
          accountant.token,
          { reasonCode: 'duplicate' },
        ),
        f.http(
          'post',
          `/staff/club-payments/${target}/reverse`,
          s.manager.token,
          { reasonCode: 'duplicate' },
        ),
      ]);
      expect(reversals.map((r) => r.status).sort()).toEqual([201, 409]);
    });

    it('the same Idempotency-Key twice at once records one payment', async () => {
      const unit = await f.unit(s.c, 'M');
      await f.owner(s.c, unit.id);
      const id = await f.membership(s.c, accountant, unit.id);
      const headers = { 'Idempotency-Key': `pay-${id}` };
      const body = { receiptNumber: `R-IDEM-${Date.now()}` };
      const [one, two] = await Promise.all([
        f.pay(accountant, id, monthly, body, headers),
        f.pay(accountant, id, monthly, body, headers),
      ]);
      expect([one.status, two.status]).toEqual([201, 201]);
      expect(one.body).toEqual(two.body);
      expect((await detail(id)).payments).toHaveLength(1);
    });
  });
});
