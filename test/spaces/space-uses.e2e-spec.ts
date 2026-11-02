import { SPACE_USE_EXPIRY_SWEEP } from '../../src/facilities/spaces/space-use-sweep';
import { eraseNow } from '../setup/erasure';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  spacesHelpers,
  type SpaceUseBody,
  type SpacesSetUp,
} from '../setup/spaces';

const HOUR = 3_600_000;
const code = (res: { body: unknown }) => (res.body as { code: string }).code;
const fields = (res: { body: unknown }) =>
  (res.body as { fields: unknown[] }).fields;

/**
 * ADR 0084: common-area use requests. A household asks for an area the
 * management opened, the staff decide; approved uses of an area never
 * overlap, and a facility's area never holds an approved use and a booking
 * at once — in either order, and when both land at the same time.
 */
describe('Spaces: common-area use requests (ADR 0084)', () => {
  let h: HttpHarness;
  let sp: ReturnType<typeof spacesHelpers>;
  let s: SpacesSetUp;
  let garden: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    sp = spacesHelpers(h);
    s = await sp.setUp('Space Uses Court');
    garden = await sp.area(s.c, { manager: s.manager });
  }, 180_000);

  afterAll(() => h.close());

  /** A home of its own and its owner: a unit's three live requests stay free. */
  const home = async () => {
    const unit = await sp.unit(s.c, 'A');
    return { unitId: unit.id, who: await sp.owner(s.c, unit.id) };
  };

  it('asked for an open area within the rules; refused when too soon, too far, too long or closed', async () => {
    const soon = await sp.askRaw(
      s.alice,
      s.homeA.id,
      garden,
      new Date(Date.now() + 2 * HOUR),
    );
    expect([soon.status, fields(soon)]).toEqual([
      400,
      [
        {
          field: 'startsAt',
          code: 'SPACE_USE_TOO_SOON',
          params: { hours: 24 },
        },
      ],
    ]);
    const far = await sp.askRaw(s.alice, s.homeA.id, garden, at(day(95), 10));
    expect(fields(far)).toEqual([
      { field: 'startsAt', code: 'SPACE_USE_TOO_FAR', params: { days: 90 } },
    ]);
    const long = await sp.askRaw(
      s.alice,
      s.homeA.id,
      garden,
      at(day(5), 8),
      13,
    );
    expect(fields(long)).toEqual([
      { field: 'endsAt', code: 'SPACE_USE_TOO_LONG', params: { hours: 12 } },
    ]);
    const shut = await sp.area(s.c, { open: false });
    const closed = await sp.askRaw(s.alice, s.homeA.id, shut, at(day(5), 10));
    expect([closed.status, code(closed)]).toEqual([
      409,
      'SPACE_USE_AREA_CLOSED',
    ]);
    const made = await sp.ask(s.alice, s.homeA.id, garden, at(day(5), 10));
    expect(made).toMatchObject({
      status: 'pending',
      unitId: s.homeA.id,
      purpose: 'A birthday for the children',
      mine: true,
    });
    // Another household's unit is not found.
    const theirs = await sp.askRaw(s.alice, s.homeB.id, garden, at(day(5), 14));
    expect([theirs.status, code(theirs)]).toEqual([404, 'UNIT_NOT_FOUND']);
  });

  it('three live per unit', async () => {
    const c = await sp.setUp('Space Uses Limit Court');
    const area = await sp.area(c.c, { manager: c.manager });
    for (const d of [3, 4, 5])
      await sp.ask(c.alice, c.homeA.id, area, at(day(d), 10));
    const fourth = await sp.askRaw(c.alice, c.homeA.id, area, at(day(6), 10));
    expect([fourth.status, code(fourth)]).toEqual([409, 'SPACE_USE_LIMIT']);
  });

  it('approved, the requester is told; refused with a code; an overlapping second one is refused at approval; withdrawn before it starts', async () => {
    const a = await sp.ask(s.alice, s.homeA.id, garden, at(day(8), 10), 3);
    const b = await sp.ask(s.bob, s.homeB.id, garden, at(day(8), 12), 2);
    const approved = (await sp.decide(s.handler, a.id, 'approve').expect(200))
      .body as SpaceUseBody;
    expect(approved.status).toBe('approved');
    expect(
      (await sp.notifications(s.c, s.alice.id, 'space_use.approved')).map(
        (n) => n.params,
      ),
    ).toEqual([{ area: a.areaCode }]);
    const clash = await sp.decide(s.handler, b.id, 'approve').expect(409);
    expect(code(clash)).toBe('SPACE_USE_OVERLAP');
    // Asked again over an approved use: told at once.
    const early = await sp.askRaw(s.bob, s.homeB.id, garden, at(day(8), 11));
    expect(code(early)).toBe('SPACE_USE_OVERLAP');
    const refused = (
      await sp
        .decide(s.handler, b.id, 'refuse', 'conflicts_with_event')
        .expect(200)
    ).body as SpaceUseBody;
    expect(refused).toMatchObject({
      status: 'refused',
      reasonCode: 'conflicts_with_event',
    });
    const again = await sp.decide(s.handler, b.id, 'approve').expect(409);
    expect([code(again), (again.body as { params: unknown }).params]).toEqual([
      'SPACE_USE_DECIDED',
      { status: 'refused' },
    ]);
    await sp
      .http('post', `/space-uses/${a.id}/withdraw`, s.alice.token, {
        reasonCode: 'plans_changed',
      })
      .expect(204);
    // The bookings handler role decides; the household only withdraws.
    await sp.decide(s.alice, b.id, 'approve').expect(403);
  });

  it('a requester sees their own; the unit’s primary sees the unit’s; the staff cancel an approved use with a code', async () => {
    const c = await sp.setUp('Space Uses Household Court');
    const area = await sp.area(c.c, { manager: c.manager });
    const other = await sp.owner(c.c, c.homeA.id);
    const theirs = await sp.ask(other, c.homeA.id, area, at(day(4), 10));
    const own = await sp.ask(c.alice, c.homeA.id, area, at(day(5), 10));
    const list = (who: { token: string }) =>
      sp
        .http('get', `/units/${c.homeA.id}/space-uses`, who.token)
        .expect(200)
        .then((r) =>
          (r.body as { data: SpaceUseBody[] }).data.map((x) => x.id),
        );
    expect(await list(c.alice)).toEqual([own.id, theirs.id]);
    expect(await list(other)).toEqual([theirs.id]);
    await sp.decide(c.handler, theirs.id, 'approve').expect(200);
    const cancelled = (
      await sp.decide(c.handler, theirs.id, 'cancel', 'safety').expect(200)
    ).body as SpaceUseBody;
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      reasonCode: 'safety',
    });
    expect(
      (await sp.notifications(c.c, other.id, 'space_use.cancelled')).map(
        (n) => n.params,
      ),
    ).toEqual([{ area: theirs.areaCode, reason: 'safety' }]);
  });

  it('on a facility’s area: refused while a booking holds the time; once approved, the facility is closed to bookings then', async () => {
    const court = await sp.facility(s.c, s.manager);
    const courtArea = await sp.area(s.c, {
      facilityId: court,
      manager: s.manager,
    });
    await sp.book(s.bob, s.homeB.id, court, at(day(9), 10));
    const held = await sp.ask(s.alice, s.homeA.id, courtArea, at(day(9), 9), 3);
    const booked = await sp.decide(s.handler, held.id, 'approve').expect(409);
    expect([code(booked), (booked.body as { params: unknown }).params]).toEqual(
      ['SPACE_USE_BOOKED', { bookings: 1 }],
    );
    const free = await sp.ask(
      s.alice,
      s.homeA.id,
      courtArea,
      at(day(10), 9),
      3,
    );
    await sp.decide(s.handler, free.id, 'approve').expect(200);
    const refused = await sp.bookRaw(s.bob, s.homeB.id, court, at(day(10), 10));
    expect([refused.status, code(refused)]).toEqual([409, 'FACILITY_CLOSED']);
    const slot = (await sp.slots(s.bob, court, day(10))).find(
      (x) => x.startsAt === at(day(10), 10).toISOString(),
    );
    expect(slot?.state).toBe('closed');
  });

  it('a request nobody decided expires at its start, once, and its requester is told', async () => {
    const c = await sp.setUp('Space Uses Expiry Court');
    const area = await sp.area(c.c, { manager: c.manager });
    const r = await sp.ask(c.alice, c.homeA.id, area, at(day(3), 10));
    const at10 = at(day(3), 10, 1);
    expect(await sp.sweep(SPACE_USE_EXPIRY_SWEEP, at10)).toBeGreaterThanOrEqual(
      1,
    );
    expect(await sp.sweep(SPACE_USE_EXPIRY_SWEEP, at10)).toBe(0);
    const row = await sp.inTx(c.c, (tx) =>
      tx.spaceUseRequest.findUniqueOrThrow({ where: { id: r.id } }),
    );
    expect(row.status).toBe('expired');
    expect(
      await sp.notifications(c.c, c.alice.id, 'space_use.expired'),
    ).toHaveLength(1);
  });

  it('a pending request is in the staff inbox for the bookings handlers', async () => {
    const c = await sp.setUp('Space Uses Inbox Court');
    const area = await sp.area(c.c, { manager: c.manager });
    const r = await sp.ask(c.alice, c.homeA.id, area, at(day(6), 10));
    const res = await sp
      .http('get', '/staff/inbox?type=space_use_request', c.manager.token)
      .expect(200);
    expect(
      (res.body as { data: { id: string; type: string }[] }).data.map((i) => [
        i.type,
        i.id,
      ]),
    ).toEqual([['space_use_request', r.id]]);
  });

  it('the requester erased: their live requests cancelled by the system, their purposes gone', async () => {
    const c = await sp.setUp('Space Uses Erasure Court');
    const area = await sp.area(c.c, { manager: c.manager });
    // A second owner living there, not the unit's primary.
    const p = await sp.owner(c.c, c.homeA.id);
    const r = await sp.ask(p, c.homeA.id, area, at(day(6), 10));
    await eraseNow(h, c.c, p.id);
    const row = await sp.inTx(c.c, (tx) =>
      tx.spaceUseRequest.findUniqueOrThrow({ where: { id: r.id } }),
    );
    expect(row).toMatchObject({
      status: 'cancelled',
      reasonCode: 'requester_left',
      purpose: null,
      endedById: null,
    });
  });

  it.each([1, 2, 3])(
    'round %i: two overlapping requests approved at once — one wins',
    async (round) => {
      const area = await sp.area(s.c, { manager: s.manager });
      const [one, two] = [await home(), await home()];
      const x = await sp.ask(
        one.who,
        one.unitId,
        area,
        at(day(20 + round), 10),
        3,
      );
      const y = await sp.ask(
        two.who,
        two.unitId,
        area,
        at(day(20 + round), 11),
        3,
      );
      const both = await Promise.all([
        sp.decide(s.handler, x.id, 'approve'),
        sp.decide(s.manager, y.id, 'approve'),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(code(both.find((r) => r.status === 409)!)).toBe(
        'SPACE_USE_OVERLAP',
      );
      expect(
        await sp.inTx(s.c, (tx) =>
          tx.spaceUseRequest.count({
            where: { commonAreaId: area, status: 'approved' },
          }),
        ),
      ).toBe(1);
    },
  );

  it.each([1, 2, 3])(
    'round %i: a booking and an approval on a facility’s area at once — never both',
    async (round) => {
      const court = await sp.facility(s.c, s.manager);
      const courtArea = await sp.area(s.c, {
        facilityId: court,
        manager: s.manager,
      });
      const when = at(day(10 + round), 10);
      const asker = await home();
      const r = await sp.ask(asker.who, asker.unitId, courtArea, when, 2);
      const [booking, approval] = await Promise.all([
        sp.bookRaw(s.bob, s.homeB.id, court, when),
        sp.decide(s.handler, r.id, 'approve'),
      ]);
      const won = [booking.status === 201, approval.status === 200];
      expect(won.filter(Boolean)).toHaveLength(1);
      if (booking.status !== 201) expect(code(booking)).toBe('FACILITY_CLOSED');
      else expect(code(approval)).toBe('SPACE_USE_BOOKED');
    },
  );
});
