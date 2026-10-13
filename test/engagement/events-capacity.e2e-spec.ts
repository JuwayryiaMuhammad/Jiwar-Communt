import {
  engagementHelpers,
  type EngagementSetUp,
  type Who,
} from '../setup/engagement';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0040: an event takes as many people as its capacity, guests included,
 * and never one more, whatever arrives at once. An answer locks the event's
 * row and counts the seats under that lock; these races run for real and
 * count rows afterwards.
 */
describe('Community life — event capacity under concurrency', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let s: EngagementSetUp;
  let people: Who[];

  const PEOPLE = 10;
  const ROUNDS = 3;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    s = await e.setUp();
    people = (await e.voters(s.c, PEOPLE)).map((v) => v.who);
  }, 180_000);

  afterAll(() => h.close());

  /** Seats taken, counted from the rows. */
  const seats = async (eventId: string) => {
    const rows = await e.x.asManager(s.c, () =>
      e.x.prisma.tenant.eventRsvp.findMany({
        where: { eventId, response: 'going' },
        select: { guests: true },
      }),
    );
    return rows.reduce((sum, r) => sum + 1 + r.guests, 0);
  };
  const sorted = (results: { status: number }[]) =>
    results.map((r) => r.status).sort();

  it('ten people for four seats: exactly four get one, the rest are told it is full', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await e.event(s.manager, { capacity: 4 });
      const results = await Promise.all(people.map((p) => e.rsvp(p, id)));
      expect(sorted(results)).toEqual([
        ...Array<number>(4).fill(204),
        ...Array<number>(PEOPLE - 4).fill(409),
      ]);
      for (const r of results.filter((x) => x.status === 409))
        expect((r.body as { code: string }).code).toBe('COMMUNITY_EVENT_FULL');
      expect(await seats(id)).toBe(4);
    }
  });

  it('guests count: answers of three seats each never overshoot, and never leave a seat that would have fit', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      // Ten seats, three per answer: three answers fit, a fourth does not.
      const id = await e.event(s.manager, { capacity: 10 });
      const results = await Promise.all(
        people.map((p) => e.rsvp(p, id, { response: 'going', guests: 2 })),
      );
      expect(sorted(results)).toEqual([
        ...Array<number>(3).fill(204),
        ...Array<number>(PEOPLE - 3).fill(409),
      ]);
      expect(await seats(id)).toBe(9);
    }
  });

  it('the last seat: two at once, one gets it', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await e.event(s.manager, { capacity: 2 });
      await e.rsvp(people[0], id).expect(204);
      const results = await Promise.all([
        e.rsvp(people[1], id),
        e.rsvp(people[2], id),
      ]);
      expect(sorted(results)).toEqual([204, 409]);
      expect(await seats(id)).toBe(2);
    }
  });

  it('one person answering twice at once holds one answer, not two', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await e.event(s.manager, { capacity: 3 });
      const results = await Promise.all([
        e.rsvp(people[0], id, { response: 'going', guests: 1 }),
        e.rsvp(people[0], id, { response: 'going', guests: 2 }),
      ]);
      expect(sorted(results)).toEqual([204, 204]);
      const rows = await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.eventRsvp.findMany({ where: { eventId: id } }),
      );
      expect(rows).toHaveLength(1);
      expect([2, 3]).toContain(await seats(id));
    }
  });

  it('answers racing a cancellation: none is taken after it, and everyone who got in is told', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await e.event(s.manager);
      const [cancel, ...answers] = await Promise.all([
        e.http('post', `/community/events/${id}/cancel`, s.manager.token, {
          reasonCode: 'weather',
        }),
        ...people.map((p) => e.rsvp(p, id)),
      ]);
      expect(cancel.status).toBe(204);
      // Each answer either got in before the cancellation or was refused.
      for (const a of answers) expect([204, 409]).toContain(a.status);
      const going = await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.eventRsvp.findMany({
          where: { eventId: id, response: 'going' },
          select: { accountId: true },
        }),
      );
      expect(going).toHaveLength(
        answers.filter((a) => a.status === 204).length,
      );
      const told = await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.notification.findMany({
          where: { kind: 'community_event.cancelled', targetId: id },
          select: { accountId: true },
        }),
      );
      // Whoever holds a seat was in before the cancel committed, so was told.
      expect(told.map((t) => t.accountId).sort()).toEqual(
        going.map((g) => g.accountId).sort(),
      );
    }
  });
});
