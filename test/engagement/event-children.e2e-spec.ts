import { HouseholdsService } from '../../src/community/households/households.service';
import { newId } from '../../src/core/common/uuid';
import { auditReaders } from '../setup/audit';
import { childrenHelpers, type Who } from '../setup/children';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const codeOf = (res: { body: unknown }) => (res.body as { code?: string }).code;

interface EventBody {
  forChildren: boolean;
  childAgeMin: number | null;
  childAgeMax: number | null;
  counts: { seats: number; children: number; remaining: number | null };
  myChildren: { memberId: string; firstName: string | null }[];
}

/**
 * ADR 0054 (amends ADR 0040): an event may be for children of an age
 * range; the household (its primary or a household delegate) registers its
 * minors, each a seat counted with the answers under the event's lock. The
 * staff see how many children per unit, never who.
 */
describe('Events for children', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof childrenHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof childrenHelpers>['setUp']>>;
  let audit: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = childrenHelpers(h);
    audit = auditReaders(h);
    s = await x.setUp('Event Children Court');
  }, 120_000);

  afterAll(() => h.close());

  const forKids = (over: Record<string, unknown> = {}) =>
    x.e.event(s.manager, {
      forChildren: true,
      childAgeMin: 6,
      childAgeMax: 10,
      ...over,
    });
  const register = (as: Who, eventId: string, memberId: string, body = {}) =>
    x.http('put', `/events/${eventId}/children/${memberId}`, as.token, body);
  const read = async (as: Who, eventId: string) =>
    (await x.http('get', `/events/${eventId}`, as.token).expect(200))
      .body as EventBody;

  async function family() {
    const home = await x.unit(s.c, 'A');
    const primary = await x.owner(s.c, home.id);
    const kid = await x.minor(primary, home.id, {
      years: 8,
      fullName: 'Omar Event Child',
    });
    return { home, primary, kid };
  }

  it('an event for children takes an age range, 0 to 17 and in order; others take none', async () => {
    const bad = async (over: Record<string, unknown>) =>
      (
        (
          await x
            .http('post', '/community/events', s.manager.token, {
              titleEn: 'Kids day',
              descriptionEn: 'Games.',
              place: 'Club',
              startsAt: x.e.at(48),
              endsAt: x.e.at(50),
              ...over,
            })
            .expect(400)
        ).body as { fields: unknown }
      ).fields;
    expect(await bad({ forChildren: true })).toEqual([
      { field: 'childAgeMin', code: 'FIELD_REQUIRED' },
      { field: 'childAgeMax', code: 'FIELD_REQUIRED' },
    ]);
    expect(await bad({ childAgeMin: 4 })).toEqual([
      { field: 'childAgeMin', code: 'FIELD_NOT_ALLOWED' },
    ]);
    expect(
      await bad({ forChildren: true, childAgeMin: 9, childAgeMax: 18 }),
    ).toEqual([
      {
        field: 'childAgeMax',
        code: 'INVALID_NUMBER',
        params: { min: 0, max: 17 },
      },
    ]);
    expect(
      await bad({ forChildren: true, childAgeMin: 9, childAgeMax: 6 }),
    ).toEqual([
      {
        field: 'childAgeMax',
        code: 'INVALID_NUMBER',
        params: { min: 9, max: 17 },
      },
    ]);
  });

  it('the primary registers a child of the age: a seat, shown to the household by first name and to the staff as a count', async () => {
    const { home, primary, kid } = await family();
    const event = await forKids();
    await register(primary, event, kid).expect(204);
    await register(primary, event, kid).expect(204);
    const seen = await read(primary, event);
    expect(seen).toMatchObject({
      forChildren: true,
      childAgeMin: 6,
      childAgeMax: 10,
      counts: { seats: 1, children: 1 },
      myChildren: [{ memberId: kid, firstName: 'Omar' }],
    });
    // Another household in the audience sees the count, never the child.
    const other = await x.owner(s.c, (await x.unit(s.c, 'A')).id);
    const theirs = await read(other, event);
    expect(theirs.myChildren).toEqual([]);
    expect(JSON.stringify(theirs)).not.toContain('Omar');
    // The staff: per unit, a count.
    await x.e.rsvp(primary, event).expect(204);
    const attendees = await x
      .http('get', `/community/events/${event}/attendees`, s.manager.token)
      .expect(200);
    expect(attendees.text).not.toContain('Omar');
    expect(
      (attendees.body as { data: { unitId: string; children: number }[] }).data,
    ).toEqual([expect.objectContaining({ unitId: home.id, children: 1 })]);
    const [entry] = await audit.tenant(s.c.tenantId, {
      action: 'community_event.child_registered',
      targetId: event,
    });
    expect(entry.metadata).toEqual({ unitId: home.id, memberId: kid });
  });

  it('refused: not of the age, not an event for children, not the primary, not a child of the unit', async () => {
    const { home, primary, kid } = await family();
    const older = await forKids({ childAgeMin: 12, childAgeMax: 15 });
    const res = await register(primary, older, kid).expect(409);
    expect(res.body).toMatchObject({
      code: 'COMMUNITY_EVENT_AGE_MISMATCH',
      params: { min: 12, max: 15 },
    });
    const plain = await x.e.event(s.manager);
    expect(codeOf(await register(primary, plain, kid).expect(409))).toBe(
      'COMMUNITY_EVENT_NOT_FOR_CHILDREN',
    );
    const event = await forKids();
    const member = await x.family(s.c, home.id, primary);
    expect(codeOf(await register(member, event, kid).expect(403))).toBe(
      'NOT_PRIMARY_RESIDENT',
    );
    expect(codeOf(await register(primary, event, newId()).expect(404))).toBe(
      'CHILD_NOT_FOUND',
    );
    expect(
      codeOf(await register(primary, event, member.memberId).expect(404)),
    ).toBe('CHILD_NOT_FOUND');
    await register(s.manager, event, kid).expect(403);
  });

  it('capacity counts the children with those going; taking it back frees the seat', async () => {
    const { primary, kid } = await family();
    const second = await x.minor(
      primary,
      (
        await x.inTx(s.c, (tx) =>
          tx.householdMember.findUniqueOrThrow({ where: { id: kid } }),
        )
      ).unitId,
      { years: 7 },
    );
    const event = await forKids({ capacity: 2 });
    const neighbour = await x.owner(s.c, (await x.unit(s.c, 'A')).id);
    await x.e.rsvp(neighbour, event).expect(204);
    await register(primary, event, kid).expect(204);
    const full = await register(primary, event, second).expect(409);
    expect(full.body).toMatchObject({
      code: 'COMMUNITY_EVENT_FULL',
      params: { remaining: 0 },
    });
    // An answer cannot take a child's seat either.
    expect(
      codeOf(
        await x.e
          .rsvp(neighbour, event, { response: 'going', guests: 1 })
          .expect(409),
      ),
    ).toBe('COMMUNITY_EVENT_FULL');
    await x
      .http('delete', `/events/${event}/children/${kid}`, primary.token)
      .expect(204);
    await x
      .http('delete', `/events/${event}/children/${kid}`, primary.token)
      .expect(204);
    await register(primary, event, second).expect(204);
    expect((await read(primary, event)).counts).toMatchObject({
      seats: 2,
      children: 1,
      remaining: 0,
    });
  });

  it('cancelling tells whoever registered a child; a child who leaves the household frees the seat', async () => {
    const { primary, kid } = await family();
    const event = await forKids();
    await register(primary, event, kid).expect(204);
    await x
      .http('post', `/community/events/${event}/cancel`, s.manager.token, {
        reasonCode: 'weather',
      })
      .expect(204);
    expect(
      (await x.notifications(s.c, primary.id, 'community_event.cancelled')).map(
        (n) => n.targetId,
      ),
    ).toContain(event);

    const other = await family();
    const next = await forKids();
    await register(other.primary, next, other.kid).expect(204);
    await x.x.as(s.c, { id: other.primary.id, type: 'resident' }, () =>
      h.moduleRef.get(HouseholdsService).removeMember(other.kid, {
        code: 'moved_out',
        text: 'Moved',
      }),
    );
    expect((await read(other.primary, next)).counts.children).toBe(0);
  });

  it('two children for the last seat at once: one registered, the other told it is full', async () => {
    for (let i = 0; i < 3; i++) {
      const a = await family();
      const b = await family();
      const event = await forKids({ capacity: 1 });
      const results = await Promise.all([
        register(a.primary, event, a.kid).then((r) => r),
        register(b.primary, event, b.kid).then((r) => r),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
      expect(
        await x.inTx(s.c, (tx) =>
          tx.eventChildRegistration.count({ where: { eventId: event } }),
        ),
      ).toBe(1);
    }
  });
});
