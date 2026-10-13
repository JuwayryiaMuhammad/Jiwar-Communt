import { NOTIFICATION_KINDS } from '../../src/core/notifications/kinds';
import {
  engagementHelpers,
  type EngagementSetUp,
  type Who,
} from '../setup/engagement';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0040: the community life tells people three things and no more — an
 * important announcement, a cancelled event they said they are going to,
 * and what became of their suggestion. All in the category `community`,
 * none critical, with ids and keys for params. Everything else is read
 * where it lives.
 */
describe('Community life — notifications', () => {
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

  const community = Object.entries(NOTIFICATION_KINDS).filter(
    ([, spec]) => spec.category === 'community',
  );
  /** Every notification of the compound, whoever it is for. */
  const all = () =>
    e.x.asManager(s.c, () =>
      e.x.prisma.tenant.notification.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );

  it('three kinds, in the category `community`, none critical, no param that could carry text', () => {
    expect(community.map(([kind]) => kind).sort()).toEqual([
      'community_announcement.important',
      'community_event.cancelled',
      'community_suggestion.status_changed',
    ]);
    for (const [, spec] of community)
      expect({ critical: spec.critical, priority: spec.priority }).toEqual({
        critical: false,
        priority: 'normal',
      });
    expect(
      community.map(([kind, spec]) => [kind, Object.keys(spec.params).sort()]),
    ).toEqual([
      ['community_announcement.important', []],
      ['community_event.cancelled', []],
      ['community_suggestion.status_changed', ['status', 'topicKey']],
    ]);
  });

  it('`community` is a category a person can turn off, like any other', async () => {
    const res = await h
      .http()
      .patch(`${API}/me/notification-preferences`)
      .set('Authorization', `Bearer ${s.owner.token}`)
      .send({
        categories: [{ category: 'community', email: false, push: false }],
      })
      .expect(200);
    expect(
      (
        res.body as { categories: { category: string; email: boolean }[] }
      ).categories.find((c) => c.category === 'community'),
    ).toEqual({ category: 'community', email: false, push: false });
    // The inbox records it whatever the preference says (ADR 0027).
    const id = await e.announcement(s.manager, { priority: 'important' });
    expect(
      (
        await e.notifications(
          s.c,
          s.owner.id,
          'community_announcement.important',
        )
      ).filter((n) => n.targetId === id),
    ).toHaveLength(1);
  });

  it('an important announcement tells the audience it has when it comes out: owners only means owners only', async () => {
    const rented = await e.unit(s.c, 'B');
    const landlord = await e.landlord(s.c, rented.id);
    const tenant = await e.tenant(s.c, rented.id);
    const id = await e.announcement(s.manager, {
      priority: 'important',
      audience: { occupancy: 'owners' },
    });
    const told = (await all())
      .filter((n) => n.targetId === id)
      .map((n) => n.accountId)
      .sort();
    expect(told).toEqual([s.owner.id, neighbour.id, landlord.id].sort());
    expect(told).not.toContain(tenant.id);
    // Never the staff who wrote it.
    expect(told).not.toContain(s.manager.id);
  });

  it('everything else tells nobody: a normal announcement, works, a new event, a poll, a vote, a published suggestion, a "we did" note', async () => {
    const before = (await all()).length;
    await e.announcement(s.manager);
    await e.works(s.manager);
    const eventId = await e.event(s.manager);
    await e.rsvp(s.owner, eventId).expect(204);
    await e
      .http('patch', `/community/events/${eventId}`, s.manager.token, {
        place: 'Moved',
      })
      .expect(204);
    const pollId = await e.poll(s.manager);
    const [yes] = await e.optionIds(s.manager, pollId);
    await e.vote(s.owner, pollId, [yes]).expect(201);
    await e
      .http('post', `/community/polls/${pollId}/close`, s.manager.token)
      .expect(204);
    const suggestionId = await e.suggestion(s.c, s.owner);
    await e.publish(s.manager, suggestionId).expect(204);
    await e
      .http('put', `/suggestion-board/${suggestionId}/support`, neighbour.token)
      .expect(204);
    expect((await all()).length).toBe(before);
    // Making an announcement important after it is out does tell them.
    const late = await e.announcement(s.manager);
    await e
      .http('patch', `/community/announcements/${late}`, s.manager.token, {
        priority: 'important',
      })
      .expect(204);
    expect((await all()).filter((n) => n.targetId === late)).not.toEqual([]);
    // Once: changing it again does not tell them twice.
    const count = (await all()).filter((n) => n.targetId === late).length;
    await e
      .http('patch', `/community/announcements/${late}`, s.manager.token, {
        pinnedUntil: e.at(5),
      })
      .expect(204);
    expect((await all()).filter((n) => n.targetId === late)).toHaveLength(
      count,
    );
  });

  it('no community notification holds a word anyone wrote', async () => {
    const SECRET = 'NOTIFICATION-FREE-TEXT';
    await e.announcement(s.manager, {
      priority: 'important',
      titleEn: `${SECRET} title`,
      bodyEn: `${SECRET} body`,
    });
    const eventId = await e.event(s.manager, {
      titleEn: `${SECRET} event`,
      place: `${SECRET} place`,
    });
    await e.rsvp(s.owner, eventId).expect(204);
    await e
      .http('post', `/community/events/${eventId}/cancel`, s.manager.token, {
        reasonCode: 'other',
      })
      .expect(204);
    const suggestionId = await e.suggestion(s.c, s.owner, {
      body: `${SECRET} suggestion`,
    });
    await e
      .move(s.manager, suggestionId, 'declined', `${SECRET} answer`)
      .expect(204);
    const rows = (await all()).filter((n) => n.kind.startsWith('community_'));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    for (const row of rows)
      for (const value of Object.values(row.params as object))
        expect(String(value)).toMatch(/^[a-z_]+$/);
  });
});
