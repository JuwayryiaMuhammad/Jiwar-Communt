import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
  type Who,
} from '../setup/facilities';

/**
 * ADR 0044: a slot takes what its capacity allows — bookings, or people —
 * and never one more, whatever arrives at once. A booking locks the slot's
 * lock row and counts what holds the slot under that lock; these races run
 * for real and count rows afterwards.
 */
describe('Bookings — slot capacity under concurrency', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;
  let homes: { unitId: string; who: Who }[];

  const PEOPLE = 8;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
    homes = [];
    for (let i = 0; i < PEOPLE; i++) {
      const unit = await f.unit(s.c, 'R');
      homes.push({ unitId: unit.id, who: await f.owner(s.c, unit.id) });
    }
  }, 180_000);

  afterAll(() => h.close());

  const codes = (results: { status: number; body: unknown }[]) =>
    results
      .map((r) =>
        `${r.status} ${(r.body as { code?: string }).code ?? ''}`.trim(),
      )
      .sort();

  it.each([1, 3])(
    'eight units book one slot of capacity %i at once: exactly that many get it',
    async (k) => {
      const court = await f.facility(s.c, s.manager, { capacity: k });
      const startsAt = at(day(2), 10);
      const results = await Promise.all(
        homes.map((x) => f.bookRaw(x.who, x.unitId, court, startsAt)),
      );
      expect(codes(results)).toEqual([
        ...Array<string>(k).fill('201'),
        ...Array<string>(PEOPLE - k).fill('409 BOOKING_SLOT_FULL'),
      ]);
      expect(await f.holding(s.c, court)).toBe(k);
    },
  );

  it('counted in people: parties of two at once into five places — two parties, four people, never six', async () => {
    const hall = await f.facility(s.c, s.manager, {
      capacity: 5,
      capacityUnit: 'people',
      maxGuests: 3,
    });
    const startsAt = at(day(3), 10);
    const results = await Promise.all(
      homes.map((x) =>
        f.bookRaw(x.who, x.unitId, hall, startsAt, { guests: 1 }),
      ),
    );
    expect(codes(results)).toEqual([
      '201',
      '201',
      ...Array<string>(PEOPLE - 2).fill('409 BOOKING_SLOT_FULL'),
    ]);
    const people = await f.inTx(s.c, (tx) =>
      tx.booking.aggregate({
        where: { facilityId: hall, status: { in: ['pending', 'confirmed'] } },
        _sum: { partySize: true },
      }),
    );
    expect(people._sum.partySize).toBe(4);
  });

  it('pending bookings hold their place too', async () => {
    const hall = await f.facility(s.c, s.manager, {
      capacity: 2,
      requiresApproval: true,
    });
    const results = await Promise.all(
      homes.map((x) => f.bookRaw(x.who, x.unitId, hall, at(day(4), 10))),
    );
    expect(codes(results)).toEqual([
      '201',
      '201',
      ...Array<string>(PEOPLE - 2).fill('409 BOOKING_SLOT_FULL'),
    ]);
  });

  it('the same Idempotency-Key twice at once books once and answers the same', async () => {
    const court = await f.facility(s.c, s.manager, { capacity: 2 });
    const headers = { 'Idempotency-Key': `book-${court}` };
    const [x] = homes;
    const [one, two] = await Promise.all([
      f.bookRaw(x.who, x.unitId, court, at(day(5), 10), {}, headers),
      f.bookRaw(x.who, x.unitId, court, at(day(5), 10), {}, headers),
    ]);
    expect([one.status, two.status]).toEqual([201, 201]);
    expect(one.body).toEqual(two.body);
    expect(await f.holding(s.c, court)).toBe(1);
  });
});
