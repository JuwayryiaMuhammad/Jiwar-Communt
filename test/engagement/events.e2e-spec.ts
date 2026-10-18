import {
  engagementHelpers,
  type EngagementSetUp,
  type Who,
} from '../setup/engagement';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface EventBody {
  id: string;
  status: string;
  titleEn: string | null;
  place: string;
  capacity: number | null;
  counts: {
    going: number;
    notGoing: number;
    seats: number;
    remaining: number | null;
  };
  myRsvp?: { response: string; guests: number; unitId: string } | null;
  cancelReason: string | null;
  attachments?: { contentType: string; url: string | null }[];
}

/**
 * ADR 0040: events — written, changed and cancelled by the staff; answered
 * by the residents they are put to, with guests up to the compound's limit;
 * counts for everyone and the list of who is coming for the staff alone.
 */
describe('Community life — events and answers', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let s: EngagementSetUp;
  let neighbour: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    s = await e.setUp();
    neighbour = await e.owner(s.c, (await e.unit(s.c, 'A')).id);
  }, 60_000);

  afterAll(() => h.close());

  const mine = async (who: Who, id: string) =>
    (await e.http('get', `/events/${id}`, who.token).expect(200))
      .body as EventBody;
  const forStaff = async (id: string) =>
    (
      await e
        .http('get', `/community/events/${id}`, s.manager.token)
        .expect(200)
    ).body as EventBody;
  const fieldsOf = (res: { body: unknown }) =>
    (res.body as { fields: unknown[] }).fields;
  const backdate = (id: string, data: object) =>
    e.x.asManager(s.c, () =>
      e.x.prisma.tenant.communityEvent.update({ where: { id }, data }),
    );

  describe('writing', () => {
    it('an event is out as soon as it is written, with its files; the staff list filters by status', async () => {
      const photo = await e.attachment(s.manager);
      const id = await e.event(s.manager, {
        capacity: 30,
        attachmentFileIds: [photo],
      });
      const view = await mine(s.owner, id);
      expect(view).toMatchObject({
        status: 'upcoming',
        titleEn: 'Garden day',
        place: 'The central garden',
        capacity: 30,
        counts: { going: 0, notGoing: 0, seats: 0, children: 0, remaining: 30 },
        myRsvp: null,
      });
      expect(view.attachments!.map((a) => a.contentType)).toEqual([
        'image/png',
      ]);
      const list = async (query: string) =>
        (
          (
            await e
              .http('get', `/community/events${query}`, s.manager.token)
              .expect(200)
          ).body as { data: EventBody[] }
        ).data.map((ev) => ev.id);
      expect(await list('?status=upcoming')).toContain(id);
      expect(await list('?status=cancelled')).not.toContain(id);
      expect(
        (
          (await e.http('get', '/events', s.owner.token).expect(200)).body as {
            data: EventBody[];
          }
        ).data.map((ev) => ev.id),
      ).toContain(id);
    });

    it('it ends after it starts; each language is whole; the place is required', async () => {
      const post = (over: object) =>
        e.http('post', '/community/events', s.manager.token, {
          titleEn: 'x',
          descriptionEn: 'y',
          place: 'z',
          startsAt: e.at(2),
          endsAt: e.at(3),
          ...over,
        });
      expect(fieldsOf(await post({ endsAt: e.at(2) }).expect(400))).toEqual([
        { field: 'endsAt', code: 'ENDS_BEFORE_START' },
      ]);
      expect(
        fieldsOf(await post({ descriptionEn: undefined }).expect(400)),
      ).toEqual([{ field: 'descriptionEn', code: 'FIELD_REQUIRED' }]);
      expect(fieldsOf(await post({ place: undefined }).expect(400))).toEqual([
        { field: 'place', code: 'FIELD_REQUIRED' },
      ]);
    });

    it('only an event that has not started changes; its capacity never drops below the seats taken', async () => {
      const id = await e.event(s.manager, { capacity: 10 });
      await e.rsvp(s.owner, id, { response: 'going', guests: 2 }).expect(204);
      await e
        .http('patch', `/community/events/${id}`, s.manager.token, {
          place: 'The club house',
          capacity: 3,
        })
        .expect(204);
      expect(await forStaff(id)).toMatchObject({
        place: 'The club house',
        capacity: 3,
        counts: { seats: 3, remaining: 0 },
      });
      expect(
        fieldsOf(
          await e
            .http('patch', `/community/events/${id}`, s.manager.token, {
              capacity: 2,
            })
            .expect(400),
        ),
      ).toEqual([
        {
          field: 'capacity',
          code: 'INVALID_NUMBER',
          params: { min: 3, max: 100000 },
        },
      ]);
      // No limit at all is always possible.
      await e
        .http('patch', `/community/events/${id}`, s.manager.token, {
          capacity: null,
        })
        .expect(204);
      expect((await forStaff(id)).counts.remaining).toBeNull();

      await backdate(id, { startsAt: e.at(-1) });
      const res = await e
        .http('patch', `/community/events/${id}`, s.manager.token, {
          place: 'Too late',
        })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'COMMUNITY_EVENT_INVALID_STATE',
        params: { status: 'ongoing' },
      });
    });
  });

  describe('answering', () => {
    it('going with guests, changed to not going, and back: one answer per account, counted with its guests', async () => {
      const id = await e.event(s.manager, { capacity: 10 });
      await e.rsvp(s.owner, id, { response: 'going', guests: 2 }).expect(204);
      await e.rsvp(neighbour, id, { response: 'going' }).expect(204);
      expect((await mine(s.owner, id)).counts).toEqual({
        going: 2,
        notGoing: 0,
        seats: 4,
        children: 0,
        remaining: 6,
      });
      expect((await mine(s.owner, id)).myRsvp).toEqual({
        response: 'going',
        guests: 2,
        unitId: s.home.id,
      });
      await e.rsvp(s.owner, id, { response: 'not_going' }).expect(204);
      expect((await mine(neighbour, id)).counts).toEqual({
        going: 1,
        notGoing: 1,
        seats: 1,
        children: 0,
        remaining: 9,
      });
      await e.rsvp(s.owner, id, { response: 'going', guests: 1 }).expect(204);
      expect((await mine(s.owner, id)).counts.seats).toBe(3);
      const rows = await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.eventRsvp.count({
          where: { eventId: id, accountId: s.owner.id },
        }),
      );
      expect(rows).toBe(1);
    });

    it('guests up to the compound’s limit, two by default, and only with someone who is going', async () => {
      const id = await e.event(s.manager);
      const tooMany = await e
        .rsvp(s.owner, id, { response: 'going', guests: 3 })
        .expect(400);
      expect(fieldsOf(tooMany)).toEqual([
        { field: 'guests', code: 'INVALID_NUMBER', params: { min: 0, max: 2 } },
      ]);
      expect(
        fieldsOf(
          await e
            .rsvp(s.owner, id, { response: 'not_going', guests: 1 })
            .expect(400),
        ),
      ).toEqual([{ field: 'guests', code: 'FIELD_NOT_ALLOWED' }]);
      // The compound raises its limit: the same answer is taken.
      await e
        .http('patch', '/community/settings', s.manager.token, {
          eventMaxGuests: 3,
        })
        .expect(200);
      await e.rsvp(s.owner, id, { response: 'going', guests: 3 }).expect(204);
      await e
        .http('patch', '/community/settings', s.manager.token, {
          eventMaxGuests: 2,
        })
        .expect(200);
    });

    it('a full event refuses the answer that does not fit, and says how many seats are left', async () => {
      const id = await e.event(s.manager, { capacity: 3 });
      await e.rsvp(s.owner, id, { response: 'going', guests: 1 }).expect(204);
      const res = await e
        .rsvp(neighbour, id, { response: 'going', guests: 1 })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'COMMUNITY_EVENT_FULL',
        params: { remaining: 1 },
      });
      // Alone, the neighbour fits; then the owner cannot add a guest.
      await e.rsvp(neighbour, id, { response: 'going' }).expect(204);
      await e.rsvp(s.owner, id, { response: 'going', guests: 2 }).expect(409);
      // Their own seats are not counted against them.
      await e.rsvp(s.owner, id, { response: 'going', guests: 1 }).expect(204);
      await e.rsvp(s.owner, id, { response: 'not_going' }).expect(204);
      expect((await mine(s.owner, id)).counts.remaining).toBe(2);
    });

    it('someone the event is put to through several units says which; another’s unit is refused', async () => {
      const second = await e.unit(s.c, 'A');
      const both = await e.who(
        s.c,
        (await e.x.resident(s.c, [(await e.unit(s.c, 'A')).id, second.id])).id,
        'resident',
      );
      const id = await e.event(s.manager);
      expect(
        fieldsOf(await e.rsvp(both, id, { response: 'going' }).expect(400)),
      ).toEqual([{ field: 'unitId', code: 'FIELD_REQUIRED' }]);
      expect(
        fieldsOf(
          await e
            .rsvp(both, id, { response: 'going', unitId: s.home.id })
            .expect(400),
        ),
      ).toEqual([{ field: 'unitId', code: 'INVALID_VALUE' }]);
      await e
        .rsvp(both, id, { response: 'going', unitId: second.id })
        .expect(204);
      expect((await mine(both, id)).myRsvp!.unitId).toBe(second.id);
    });

    it('an event that started, ended or was cancelled takes no answer', async () => {
      const started = await e.event(s.manager);
      await backdate(started, { startsAt: e.at(-1) });
      const cancelled = await e.event(s.manager);
      await e
        .http(
          'post',
          `/community/events/${cancelled}/cancel`,
          s.manager.token,
          {
            reasonCode: 'weather',
          },
        )
        .expect(204);
      for (const [id, status] of [
        [started, 'ongoing'],
        [cancelled, 'cancelled'],
      ] as const) {
        const res = await e.rsvp(s.owner, id).expect(409);
        expect(res.body).toMatchObject({
          code: 'COMMUNITY_EVENT_INVALID_STATE',
          params: { status },
        });
      }
    });
  });

  describe('who is coming', () => {
    it('the staff get the list by name, unit and guests; a resident gets counts and nothing else', async () => {
      const id = await e.event(s.manager);
      await e.rsvp(s.owner, id, { response: 'going', guests: 2 }).expect(204);
      await e.rsvp(neighbour, id, { response: 'not_going' }).expect(204);
      const list = async (query = '') =>
        (
          (
            await e
              .http(
                'get',
                `/community/events/${id}/attendees${query}`,
                s.manager.token,
              )
              .expect(200)
          ).body as {
            data: {
              accountId: string;
              fullName: string;
              unitCode: string;
              response: string;
              guests: number;
            }[];
          }
        ).data;
      const going = await list();
      expect(going).toHaveLength(1);
      expect(going[0]).toMatchObject({
        accountId: s.owner.id,
        unitCode: s.home.code,
        response: 'going',
        guests: 2,
      });
      expect(going[0].fullName).toMatch(/^Person /);
      expect(
        (await list('?response=not_going')).map((a) => a.accountId),
      ).toEqual([neighbour.id]);
      // The resident's view: no name, no list, no route to one.
      const view = JSON.stringify(await mine(neighbour, id));
      expect(view).not.toContain(s.owner.id);
      expect(view).not.toContain(going[0].fullName);
      await e
        .http('get', `/community/events/${id}/attendees`, neighbour.token)
        .expect(403);
    });
  });

  describe('cancelling', () => {
    it('with a reason code; everyone who said going is told, and nobody else; it stays listed as cancelled', async () => {
      const id = await e.event(s.manager);
      const away = await e.owner(s.c, (await e.unit(s.c, 'A')).id);
      await e.rsvp(s.owner, id, { response: 'going' }).expect(204);
      await e.rsvp(neighbour, id, { response: 'not_going' }).expect(204);
      expect(
        fieldsOf(
          await e
            .http('post', `/community/events/${id}/cancel`, s.manager.token, {
              reasonCode: 'boredom',
            })
            .expect(400),
        ),
      ).toMatchObject([{ field: 'reasonCode', code: 'INVALID_REASON_CODE' }]);
      await e
        .http('post', `/community/events/${id}/cancel`, s.manager.token, {
          reasonCode: 'weather',
        })
        .expect(204);

      const told = async (who: Who) =>
        (
          await e.notifications(s.c, who.id, 'community_event.cancelled')
        ).filter((n) => n.targetId === id);
      expect(await told(s.owner)).toHaveLength(1);
      expect((await told(s.owner))[0]).toMatchObject({
        targetType: 'community_event',
        params: {},
      });
      expect(await told(neighbour)).toEqual([]);
      expect(await told(away)).toEqual([]);

      expect(await mine(s.owner, id)).toMatchObject({
        status: 'cancelled',
        cancelReason: 'weather',
        myRsvp: { response: 'going' },
      });
      const again = await e
        .http('post', `/community/events/${id}/cancel`, s.manager.token, {
          reasonCode: 'other',
        })
        .expect(409);
      expect(again.body).toMatchObject({ params: { status: 'cancelled' } });
    });
  });
});
