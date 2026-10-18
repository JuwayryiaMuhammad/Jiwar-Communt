import { HouseholdsService } from '../../src/community/households/households.service';
import { childrenHelpers } from '../setup/children';
import { at, day } from '../setup/compound-clock';
import { facilitiesHelpers } from '../setup/facilities';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const fieldsOf = (res: { body: unknown }) =>
  (res.body as { fields: unknown }).fields;

/**
 * ADR 0054 (amends ADR 0044): a birthday space is a bookable facility that
 * takes a child as a booking's occasion. The household names one of the
 * booking unit's minors; it sees the child's first name while the child is
 * the unit's; the staff see only that there is one. Which child never
 * changes.
 */
describe('Facilities — a child as the occasion', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof childrenHelpers>;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof childrenHelpers>['setUp']>>;
  let handler: Awaited<
    ReturnType<ReturnType<typeof facilitiesHelpers>['staff']>
  >;
  let space: string;
  let court: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = childrenHelpers(h);
    f = facilitiesHelpers(h);
    s = await x.setUp('Occasion Court');
    handler = await f.staff(s.c);
    space = await f.facility(s.c, s.manager, {
      nameEn: 'Party room',
      nameAr: 'قاعة الحفلات',
      childOccasions: true,
      weeklyQuota: 10,
      peakQuota: 10,
    });
    court = await f.facility(s.c, s.manager, {
      weeklyQuota: 10,
      peakQuota: 10,
    });
  }, 120_000);

  afterAll(() => h.close());

  let hour = 9;
  const nextSlot = () => at(day(2), hour++, 0);

  it("names one of the unit's children: the household sees the first name, the staff only that there is one", async () => {
    const home = await x.unit(s.c, 'A');
    const primary = await x.owner(s.c, home.id);
    const kid = await x.minor(primary, home.id, {
      fullName: 'Omar Party Child',
    });
    const booking = (await f.book(primary, home.id, space, nextSlot(), {
      occasionMemberId: kid,
    })) as unknown as { id: string; occasion: unknown };
    expect(booking.occasion).toEqual({ memberId: kid, firstName: 'Omar' });
    const mine = await x
      .http('get', `/bookings/${booking.id}`, primary.token)
      .expect(200);
    expect((mine.body as { occasion: unknown }).occasion).toEqual({
      memberId: kid,
      firstName: 'Omar',
    });
    const staff = await x
      .http('get', `/staff/bookings/${booking.id}`, handler.token)
      .expect(200);
    expect((staff.body as { childOccasion: boolean }).childOccasion).toBe(true);
    expect(staff.text).not.toMatch(new RegExp(`Omar|${kid}`));

    // The child leaves the household: the booking stays, the name goes.
    await x.x.as(s.c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef.get(HouseholdsService).removeMember(kid, {
        code: 'moved_out',
        text: 'Moved',
      }),
    );
    const after = await x
      .http('get', `/bookings/${booking.id}`, primary.token)
      .expect(200);
    expect((after.body as { occasion: unknown }).occasion).toEqual({
      memberId: kid,
      firstName: null,
    });
  });

  it('only on a facility that takes one, and only a child of the booking unit', async () => {
    const home = await x.unit(s.c, 'A');
    const primary = await x.owner(s.c, home.id);
    const kid = await x.minor(primary, home.id);
    expect(
      fieldsOf(
        await f
          .bookRaw(primary, home.id, court, nextSlot(), {
            occasionMemberId: kid,
          })
          .then((r) => {
            expect(r.status).toBe(400);
            return r;
          }),
      ),
    ).toEqual([{ field: 'occasionMemberId', code: 'FIELD_NOT_ALLOWED' }]);
    const elsewhere = await x.unit(s.c, 'A');
    const theirKid = await x.minor(
      await x.owner(s.c, elsewhere.id),
      elsewhere.id,
    );
    const adult = await x.family(s.c, home.id, primary);
    for (const memberId of [theirKid, adult.memberId]) {
      const res = await f.bookRaw(primary, home.id, space, nextSlot(), {
        occasionMemberId: memberId,
      });
      expect(res.status).toBe(400);
      expect(fieldsOf(res)).toEqual([
        { field: 'occasionMemberId', code: 'PERSON_NOT_OF_UNIT' },
      ]);
    }
  });

  it('which child is fixed: the database refuses a change', async () => {
    const home = await x.unit(s.c, 'A');
    const primary = await x.owner(s.c, home.id);
    const kid = await x.minor(primary, home.id);
    const booking = await f.book(primary, home.id, space, nextSlot(), {
      occasionMemberId: kid,
    });
    await expect(
      x.inTx(s.c, (tx) =>
        tx.booking.update({
          where: { id: booking.id },
          data: { occasionMemberId: null },
        }),
      ),
    ).rejects.toThrow(/keeps its occasion/);
  });
});
