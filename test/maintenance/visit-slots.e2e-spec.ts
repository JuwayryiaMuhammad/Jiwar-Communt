import {
  addDays,
  localDate,
  zonedInstant,
} from '../../src/maintenance/visits/visit-slots';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };
type Slots = { data: { startsAt: string; endsAt: string }[]; nextCursor: null };

const TZ = 'Africa/Cairo';
const HOUR = 3_600_000;

/**
 * ADR 0038: the free windows a resident may pick when a visit moves. The
 * compound's visiting hours (08:00–18:00 in one-hour slots by default) in
 * its time zone, minus what a proposal would be refused for and the
 * technician's other active visits. `counter` keeps taking any valid window.
 */
describe('Maintenance — visit slots', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  let family: Who;
  let neighbour: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    const joined = await d.x.joinFamily(s.c, s.unit.id, s.owner);
    family = {
      id: joined.id,
      token: await h.tokenFor({
        sub: joined.id,
        tid: s.c.tenantId,
        typ: 'family',
      }),
    };
    const other = await d.x.unit(s.c);
    neighbour = await d.who(
      s.c,
      (await d.x.resident(s.c, [other.id])).id,
      'resident',
    );
  }, 90_000);

  afterAll(() => h.close());

  const tech = () => s.techs[0];
  const code = (res: { body: unknown }) => (res.body as { code: string }).code;
  /** Tomorrow, in the compound's zone. */
  const tomorrow = () => addDays(localDate(new Date(), TZ), 1);
  const at = (day: string, hour: number) =>
    zonedInstant(day, hour * 60, TZ)!.toISOString();

  async function assigned(): Promise<string> {
    const id = await d.openTicket(s);
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: tech().id,
      })
      .expect(204);
    return id;
  }

  const slots = (id: string, query: string, who: Who = s.owner) =>
    d.http('get', `/tickets/${id}/visit-slots?${query}`, who.token);

  const starts = (res: { body: unknown }) =>
    (res.body as Slots).data.map((x) => x.startsAt);

  it('a day of the compound’s visiting hours, in its time zone, an hour each', async () => {
    const id = await assigned();
    const day = tomorrow();
    const res = await slots(id, `from=${day}&days=1`).expect(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect((res.body as Slots).nextCursor).toBeNull();
    expect(starts(res)).toEqual(
      [8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((hr) => at(day, hr)),
    );
    for (const slot of (res.body as Slots).data)
      expect(
        new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime(),
      ).toBe(HOUR);
    // A week by default.
    const week = await slots(id, `from=${day}`).expect(200);
    expect(starts(week)).toHaveLength(70);
  });

  it('leaves out the technician’s other visits, never the one being moved', async () => {
    const mine = await assigned();
    const other = await assigned();
    const day = addDays(tomorrow(), 1);
    // The other ticket's visit 10:00–11:30 local; this ticket's at 09:00.
    for (const [id, from, to] of [
      [other, at(day, 10), new Date(Date.parse(at(day, 10)) + 1.5 * HOUR)],
      [mine, at(day, 9), new Date(Date.parse(at(day, 9)) + HOUR)],
    ] as const) {
      await d
        .http('post', `/technician/tickets/${id}/visits`, tech().token, {
          startsAt: from,
          endsAt: new Date(to).toISOString(),
        })
        .expect(201);
    }
    const res = await slots(mine, `from=${day}&days=1`).expect(200);
    expect(starts(res)).toContain(at(day, 9));
    expect(starts(res)).not.toContain(at(day, 10));
    expect(starts(res)).not.toContain(at(day, 11));
    expect(starts(res)).toContain(at(day, 12));
  });

  it('a slot from the list is a window the counter-proposal accepts', async () => {
    const id = await assigned();
    const day = addDays(tomorrow(), 2);
    const proposed = await d
      .http('post', `/technician/tickets/${id}/visits`, tech().token, {
        startsAt: at(day, 14),
        endsAt: at(day, 15),
      })
      .expect(201);
    const [first] = (
      (await slots(id, `from=${day}&days=1`).expect(200)).body as Slots
    ).data;
    await d
      .http(
        'post',
        `/tickets/${id}/visits/${(proposed.body as { id: string }).id}/counter`,
        s.owner.token,
        first,
      )
      .expect(201);
  });

  it('follows the manager’s visiting hours; hours shorter than a slot are refused', async () => {
    const id = await assigned();
    const day = tomorrow();
    await d
      .http('patch', '/maintenance/settings', s.manager.token, {
        visitHoursStart: 600,
        visitHoursEnd: 720,
        visitSlotMinutes: 30,
      })
      .expect(200);
    try {
      const res = await slots(id, `from=${day}&days=1`).expect(200);
      expect(starts(res)).toEqual([
        at(day, 10),
        at(day, 10.5),
        at(day, 11),
        at(day, 11.5),
      ]);
      const short = await d
        .http('patch', '/maintenance/settings', s.manager.token, {
          visitHoursEnd: 615,
        })
        .expect(400);
      expect((short.body as { fields: unknown[] }).fields).toEqual([
        {
          field: 'visitHoursEnd',
          code: 'VISIT_HOURS_TOO_SHORT',
          params: { min: 630 },
        },
      ]);
    } finally {
      await d
        .http('patch', '/maintenance/settings', s.manager.token, {
          visitHoursStart: 480,
          visitHoursEnd: 1080,
          visitSlotMinutes: 60,
        })
        .expect(200);
    }
  });

  it('only while a technician holds the ticket, and never for a common area', async () => {
    const queued = await d.openTicket(s);
    const res = await slots(queued, 'days=1').expect(409);
    expect(code(res)).toBe('TICKET_INVALID_TRANSITION');
    const area = await d
      .http('post', '/maintenance/tickets', s.supervisor.token, {
        commonArea: 'Lobby',
        categoryId: await d.categoryId(s.c, 'general'),
        description: 'Common area',
        reporterAccountId: s.owner.id,
      })
      .expect(201);
    const areaId = (area.body as { id: string }).id;
    await d
      .http(
        'post',
        `/maintenance/tickets/${areaId}/assign`,
        s.supervisor.token,
        {
          technicianId: tech().id,
        },
      )
      .expect(204);
    const none = await slots(areaId, 'days=1').expect(409);
    expect(code(none)).toBe('VISIT_NOT_FOR_COMMON_AREA');
  });

  it('whoever reaches the visits: an adult who lives there yes; a neighbour, the technician no', async () => {
    const id = await assigned();
    await slots(id, 'days=1', family).expect(200);
    const other = await slots(id, 'days=1', neighbour).expect(404);
    expect(code(other)).toBe('TICKET_NOT_FOUND');
    await slots(id, 'days=1', tech()).expect(403);
  });

  it('a day that does not exist is refused', async () => {
    const id = await assigned();
    const res = await slots(id, 'from=2030-02-31').expect(400);
    expect((res.body as { fields: unknown[] }).fields).toEqual([
      {
        field: 'from',
        code: 'INVALID_FORMAT',
        params: { format: 'YYYY-MM-DD' },
      },
    ]);
  });
});
