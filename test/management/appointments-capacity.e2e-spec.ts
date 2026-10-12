import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  managementHelpers,
  type ManagementSetUp,
  type Who,
} from '../setup/management';

/**
 * ADR 0039: a slot takes as many appointments as the compound's capacity
 * and never one more, whatever arrives at once. A booking locks its slot's
 * row and counts the live appointments under that lock; these races run for
 * real and count rows afterwards.
 */
describe('Management appointments — slot capacity under concurrency', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof managementHelpers>;
  let s: ManagementSetUp;
  let residents: Who[];
  let topicId: string;

  const PEOPLE = 10;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = managementHelpers(h);
    s = await m.setUp();
    topicId = await m.topicId(s.c);
    residents = [];
    for (let i = 0; i < PEOPLE; i++)
      residents.push(
        await m.who(
          s.c,
          (await m.x.resident(s.c, [(await m.x.unit(s.c)).id])).id,
          'resident',
        ),
      );
  }, 180_000);

  afterAll(() => h.close());

  const capacity = (appointmentSlotCapacity: number) =>
    m
      .http('patch', '/management/request-settings', s.manager.token, {
        appointmentSlotCapacity,
      })
      .expect(200);
  const live = (startsAt: string) =>
    m.x.asManager(s.c, () =>
      m.x.prisma.tenant.managementAppointment.count({
        where: {
          startsAt: new Date(startsAt),
          status: { in: ['requested', 'proposed', 'confirmed'] },
        },
      }),
    );
  /** How many live appointments each request has. */
  const livePerRequest = async () => {
    const rows = await m.x.asManager(s.c, () =>
      m.x.prisma.tenant.managementAppointment.groupBy({
        by: ['requestId'],
        where: { status: { in: ['requested', 'proposed', 'confirmed'] } },
        _count: true,
      }),
    );
    return rows.map((r) => r._count);
  };
  /** Free slots nobody in this suite has touched yet, soonest first. */
  let used = 0;
  const freshSlots = async (n: number) => {
    const all = await m.slots(residents[0], 31);
    const mine = all.slice(used, used + n).map((x) => x.startsAt);
    used += n;
    if (mine.length < n) throw new Error('not enough free slots');
    return mine;
  };

  it.each([1, 3])(
    'ten residents open an appointment on one slot of capacity %i: exactly that many get it',
    async (k) => {
      await capacity(k);
      const [slot] = await freshSlots(1);
      const before = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.managementRequest.count(),
      );
      const results = await Promise.all(
        residents.map((who) => m.book(s.c, who, slot, topicId)),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([
        ...Array<number>(k).fill(201),
        ...Array<number>(PEOPLE - k).fill(409),
      ]);
      for (const r of results.filter((x) => x.status === 409))
        expect(r.body).toMatchObject({
          code: 'MANAGEMENT_APPOINTMENT_SLOT_FULL',
        });
      expect(await live(slot)).toBe(k);
      // A refused booking left nothing: no request, no number taken.
      const after = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.managementRequest.findMany({
          orderBy: { number: 'asc' },
          select: { number: true },
        }),
      );
      expect(after).toHaveLength(before + k);
      expect(after.map((r) => r.number)).toEqual(after.map((_, i) => i + 1));
      // The full slot is no longer offered.
      expect(
        (await m.slots(residents[0], 31)).map((x) => x.startsAt),
      ).not.toContain(slot);
    },
  );

  it('ten appointments move to one slot of capacity 2 at once: two move, eight stay where they were', async () => {
    await capacity(2);
    const [target, ...own] = await freshSlots(PEOPLE + 1);
    const ids: string[] = [];
    for (const [i, who] of residents.entries()) {
      const res = await m.book(s.c, who, own[i], topicId).expect(201);
      ids.push((res.body as { id: string }).id);
    }
    const results = await Promise.all(
      residents.map((who, i) =>
        m.http(
          'post',
          `/management-requests/${ids[i]}/appointment`,
          who.token,
          { startsAt: target, mode: 'phone' },
        ),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      201,
      201,
      ...Array<number>(PEOPLE - 2).fill(409),
    ]);
    expect(await live(target)).toBe(2);
    // The losers' own slots were given back to them with the rollback, and
    // the winners left theirs: every request has exactly one live appointment.
    for (const [i, r] of results.entries())
      expect(await live(own[i])).toBe(r.status === 201 ? 0 : 1);
    const counts = await livePerRequest();
    expect(new Set(counts)).toEqual(new Set([1]));
  });

  it('staff propose while the residents pick, one slot of capacity 1: one of them holds it', async () => {
    await capacity(1);
    const [target, a, b] = await freshSlots(3);
    const first = await m.book(s.c, residents[0], a, topicId).expect(201);
    const second = await m.book(s.c, residents[1], b, topicId).expect(201);
    const [x, y] = [first, second].map((r) => (r.body as { id: string }).id);
    for (let round = 0; round < 3; round++) {
      const results = await Promise.all([
        m.http(
          'post',
          `/management/requests/${x}/appointment/propose`,
          s.manager.token,
          { startsAt: target, mode: 'in_person' },
        ),
        m.http(
          'post',
          `/management-requests/${y}/appointment`,
          residents[1].token,
          { startsAt: target, mode: 'in_person' },
        ),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await live(target)).toBe(1);
      // Give the slot back for the next round.
      const winner = results[0].status === 201 ? x : y;
      await m
        .http(
          'post',
          `/management/requests/${winner}/appointment/cancel`,
          s.manager.token,
          { reasonCode: 'other' },
        )
        .expect(204);
      expect(await live(target)).toBe(0);
    }
  });

  it('a cancellation frees its place at once: the next booking takes it, and only one', async () => {
    await capacity(1);
    const [slot] = await freshSlots(1);
    const held = await m.book(s.c, residents[0], slot, topicId).expect(201);
    const id = (held.body as { id: string }).id;
    await m.book(s.c, residents[1], slot, topicId).expect(409);
    await m
      .http(
        'post',
        `/management-requests/${id}/appointment/cancel`,
        residents[0].token,
        {
          reasonCode: 'cannot_attend',
        },
      )
      .expect(204);
    const results = await Promise.all(
      residents.slice(1, 6).map((who) => m.book(s.c, who, slot, topicId)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      201, 409, 409, 409, 409,
    ]);
    expect(await live(slot)).toBe(1);
  });

  it('the same person rebooking their own slot keeps it: their old place is theirs to reuse', async () => {
    await capacity(1);
    const [slot] = await freshSlots(1);
    const res = await m.book(s.c, residents[0], slot, topicId).expect(201);
    const id = (res.body as { id: string }).id;
    await m
      .http(
        'post',
        `/management-requests/${id}/appointment`,
        residents[0].token,
        {
          startsAt: slot,
          mode: 'phone',
        },
      )
      .expect(201);
    expect(await live(slot)).toBe(1);
  });
});
