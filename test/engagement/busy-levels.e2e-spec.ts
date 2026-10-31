import { newId } from '../../src/core/common/uuid';
import { at, day, dbClock } from '../setup/compound-clock';
import { facilitiesHelpers } from '../setup/facilities';
import { gateHelpers } from '../setup/gate';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0071 (amending ADR 0044): how busy a gate and a bookable facility
 * are — levels, never counts. A slot's share of its capacity; a facility
 * now and usually at this hour (null with fewer than four weeks); a gate's
 * entries in the last fifteen minutes against the compound's thresholds.
 */
describe('Daily life — busy levels', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof facilitiesHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
  }, 180_000);

  afterAll(() => h.close());

  it('a slot reads its level from its share of the capacity, never a count', async () => {
    const court = await f.facility(s.c, s.manager, {
      capacity: 3,
      capacityUnit: 'bookings',
    });
    const at10 = at(day(2), 10);
    const free = (await f.slots(s.alice, court, day(2))).find(
      (x) => x.startsAt === at10.toISOString(),
    )!;
    expect(free).toMatchObject({ state: 'free', busy: 'quiet' });
    await f.book(s.alice, s.homeA.id, court, at10);
    await f.book(s.bob, s.homeB.id, court, at10);
    const slot = (await f.slots(s.alice, court, day(2))).find(
      (x) => x.startsAt === at10.toISOString(),
    )!;
    expect(slot).toMatchObject({ state: 'free', busy: 'busy' });
    expect(JSON.stringify(slot)).not.toMatch(/"(taken|count|capacity)"/);
  });

  it('a facility reads how busy it is now; usually is null while it is new; a walk-in has neither', async () => {
    const court = await f.facility(s.c, s.manager, { nameEn: 'New court' });
    const seen = (
      await f.http('get', `/facilities/${court}`, s.alice.token).expect(200)
    ).body as { busyNow: string | null; usuallyBusy: string | null };
    expect(seen).toMatchObject({ busyNow: 'quiet', usuallyBusy: null });
    const pool = await f.facility(s.c, s.manager, {
      mode: 'walk_in',
      nameEn: 'Pool',
      slotMinutes: undefined,
      capacity: undefined,
    });
    expect(
      (await f.http('get', `/facilities/${pool}`, s.alice.token).expect(200))
        .body,
    ).toMatchObject({ busyNow: null, usuallyBusy: null });
  });

  it('a people-counted facility counts a booking’s companions as its slot does (ADR 0070)', async () => {
    // A booking held now (the lead time keeps one from being made through
    // the API): one booker and three companions of five places.
    const heldNow = async (companions: number) => {
      const room = await f.facility(s.c, s.manager, {
        nameEn: `Room ${companions}`,
        capacity: 5,
        capacityUnit: 'people',
      });
      const now = dbClock().getTime();
      await f.x.asManager(s.c, () =>
        f.x.prisma.tenant.booking.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            facilityId: room,
            unitId: s.homeA.id,
            bookedById: s.alice.id,
            startsAt: new Date(now - 30 * 60_000),
            endsAt: new Date(now + 30 * 60_000),
            guests: 0,
            partySize: 1,
            companions,
            peak: false,
            status: 'confirmed',
          },
        }),
      );
      return (
        (await f.http('get', `/facilities/${room}`, s.alice.token).expect(200))
          .body as { busyNow: string }
      ).busyNow;
    };
    expect(await heldNow(0)).toBe('quiet');
    expect(await heldNow(3)).toBe('busy');
  });

  it('a gate reads quiet with no entries; the thresholds are the compound’s, the busy one above the normal one', async () => {
    const g = gateHelpers(h);
    const gate = await g.gate(s.c);
    const status = (
      (await f.http('get', '/gates/status', s.alice.token).expect(200))
        .body as {
        data: { id: string; busy: string }[];
      }
    ).data.find((x) => x.id === gate.id)!;
    expect(status.busy).toBe('quiet');
    expect(
      (
        await f
          .http('patch', '/staff/gate/settings', s.manager.token, {
            gateBusyNormalFrom: 20,
            gateBusyBusyFrom: 20,
          })
          .expect(400)
      ).body,
    ).toMatchObject({
      fields: [{ field: 'gateBusyBusyFrom', code: 'INVALID_VALUE' }],
    });
    await f
      .http('patch', '/staff/gate/settings', s.manager.token, {
        gateBusyNormalFrom: 5,
        gateBusyBusyFrom: 12,
      })
      .expect(200);
  });
});
