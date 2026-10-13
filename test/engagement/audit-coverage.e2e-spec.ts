import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { ANNOUNCE_SWEEP } from '../../src/engagement/announcements/announcements.service';
import { POLL_CLOSE_SWEEP } from '../../src/engagement/polls/polls.service';
import { auditReaders } from '../setup/audit';
import {
  COMMUNITY_COVERAGE,
  ENGAGEMENT_COVERAGE,
  FILES_COVERAGE,
  MAINTENANCE_COVERAGE,
  MANAGEMENT_COVERAGE,
  PARCELS_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
  R1_COVERAGE,
  RESIDENT_SCREENS_COVERAGE,
} from '../setup/audit-coverage-split';
import {
  engagementHelpers,
  type EngagementSetUp,
  type Who,
} from '../setup/engagement';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per community catalog entry (ADR 0014, 0040): actor, target,
 * changes and metadata — ids, keys, dates, counts and reason codes; never a
 * title, a text, a place, a summary, a note, an answer or a choice.
 */
const covered = new Set<string>();

/** Planted in every free text a scenario writes: no audit row may hold it. */
const MARKER = 'AUDIT-FREE-TEXT';

describe('Audit coverage — community life', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let s: EngagementSetUp;
  let neighbour: Who;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    s = await e.setUp();
    neighbour = await e.owner(s.c, (await e.unit(s.c, 'A')).id);
    read = auditReaders(h);
  }, 60_000);

  afterAll(() => h.close());

  async function rows(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    for (const row of found) expect(JSON.stringify(row)).not.toContain(MARKER);
    return found;
  }
  async function single(action: string, targetId: string) {
    const found = await rows(action, targetId);
    expect(found).toHaveLength(1);
    return found[0];
  }
  const byManager = (targetType: string) => ({
    actorType: 'account',
    actorId: s.manager.id,
    targetType,
  });

  describe('set-up', () => {
    it('engagement.settings_changed — the limit by value', async () => {
      await e
        .http('patch', '/community/settings', s.manager.token, {
          eventMaxGuests: 5,
        })
        .expect(200);
      const row = await single('engagement.settings_changed', s.c.tenantId);
      expect(row).toMatchObject(byManager('tenant'));
      expect(row.changes).toEqual({ eventMaxGuests: { from: 2, to: 5 } });
    });

    it('suggestion_topic.created and .updated — the key and state by value, the names as changed', async () => {
      const id = (
        (
          await e
            .http('post', '/community/suggestion-topics', s.manager.token, {
              key: 'audit_topic',
              nameAr: `${MARKER} ع`,
              nameEn: `${MARKER} Topic`,
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      const created = await single('suggestion_topic.created', id);
      expect(created).toMatchObject(byManager('suggestion_topic'));
      expect(created.changes).toEqual({
        key: { from: null, to: 'audit_topic' },
        nameAr: { changed: true },
        nameEn: { changed: true },
        active: { from: null, to: true },
      });
      await e
        .http('patch', `/community/suggestion-topics/${id}`, s.manager.token, {
          nameEn: `${MARKER} Renamed`,
          active: false,
        })
        .expect(200);
      const updated = await single('suggestion_topic.updated', id);
      expect(updated.changes).toEqual({
        nameEn: { changed: true },
        active: { from: true, to: false },
      });
    });
  });

  describe('announcements', () => {
    let id: string;

    it('announcement.created — its settings by value, never its words; the place as changed', async () => {
      id = await e.draft(s.manager, {
        kind: 'works',
        titleEn: `${MARKER} title`,
        bodyEn: `${MARKER} body`,
        priority: 'important',
        audience: { occupancy: 'owners' },
        works: {
          startsAt: e.at(1),
          endsAt: e.at(3),
          areaKind: 'facility',
          place: `${MARKER} place`,
        },
      });
      const row = await single('announcement.created', id);
      expect(row).toMatchObject(byManager('announcement'));
      expect(row.changes).toMatchObject({
        kind: { from: null, to: 'works' },
        priority: { from: null, to: 'important' },
        audienceOccupancy: { from: null, to: 'owners' },
        worksAreaKind: { from: null, to: 'facility' },
        worksPlace: { changed: true },
      });
      expect(Object.keys(row.changes as object)).not.toContain('titleEn');
    });

    it('announcement.changed — the settings that moved', async () => {
      await e
        .http('patch', `/community/announcements/${id}`, s.manager.token, {
          pinnedUntil: e.at(48),
          audience: { occupancy: 'everyone' },
        })
        .expect(204);
      const row = await single('announcement.changed', id);
      expect(Object.keys(row.changes as object).sort()).toEqual([
        'audienceOccupancy',
        'pinnedUntil',
      ]);
      expect(
        (row.changes as Record<string, unknown>).audienceOccupancy,
      ).toEqual({
        from: 'owners',
        to: 'everyone',
      });
    });

    it('announcement.published and .announced — the date and a count of who was told', async () => {
      await e
        .http('post', `/community/announcements/${id}/publish`, s.manager.token)
        .expect(204);
      const published = await single('announcement.published', id);
      expect(published).toMatchObject(byManager('announcement'));
      expect(published.metadata).toMatchObject({
        scheduled: false,
        fromStatus: 'draft',
      });
      const announced = await single('announcement.announced', id);
      expect(announced.metadata).toEqual({ recipients: 2 });
    });

    it('announcement.edited — the version number, never the words', async () => {
      await e
        .http('patch', `/community/announcements/${id}`, s.manager.token, {
          bodyEn: `${MARKER} corrected`,
        })
        .expect(204);
      const row = await single('announcement.edited', id);
      expect(row.metadata).toEqual({ version: 2, afterPublication: true });
    });

    it('announcement.announced — by the system when the sweep tells a scheduled one', async () => {
      const scheduled = await e.draft(s.manager, { priority: 'important' });
      await e
        .http(
          'post',
          `/community/announcements/${scheduled}/publish`,
          s.manager.token,
          { publishAt: e.at(1) },
        )
        .expect(204);
      expect(
        (await single('announcement.published', scheduled)).metadata,
      ).toMatchObject({ scheduled: true });
      await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.announcement.update({
          where: { id: scheduled },
          data: { publishAt: e.at(-0.1) },
        }),
      );
      await e.sweep(ANNOUNCE_SWEEP);
      const row = await single('announcement.announced', scheduled);
      expect(row).toMatchObject({ actorType: 'system', actorId: null });
    });

    it('announcement.archived — where it stood', async () => {
      await e
        .http('post', `/community/announcements/${id}/archive`, s.manager.token)
        .expect(204);
      const row = await single('announcement.archived', id);
      expect(row.metadata).toEqual({ fromStatus: 'published' });
    });
  });

  describe('events', () => {
    let id: string;

    it('community_event.created — dates, capacity and audience by value; words and place as changed', async () => {
      id = await e.event(s.manager, {
        titleEn: `${MARKER} title`,
        descriptionEn: `${MARKER} description`,
        place: `${MARKER} place`,
        capacity: 20,
      });
      const row = await single('community_event.created', id);
      expect(row).toMatchObject(byManager('community_event'));
      expect(row.changes).toMatchObject({
        capacity: { from: null, to: 20 },
        titleEn: { changed: true },
        descriptionEn: { changed: true },
        place: { changed: true },
      });
    });

    it('community_event.changed — what moved', async () => {
      await e
        .http('patch', `/community/events/${id}`, s.manager.token, {
          capacity: 30,
          place: `${MARKER} elsewhere`,
        })
        .expect(204);
      const row = await single('community_event.changed', id);
      expect(row.changes).toEqual({
        capacity: { from: 20, to: 30 },
        place: { changed: true },
      });
    });

    it('community_event.rsvp_changed — the resident’s own answer; the same answer again is no change', async () => {
      await e.rsvp(s.owner, id, { response: 'going', guests: 1 }).expect(204);
      await e.rsvp(s.owner, id, { response: 'going', guests: 1 }).expect(204);
      const row = await single('community_event.rsvp_changed', id);
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: s.owner.id,
        targetType: 'community_event',
      });
      expect(row.metadata).toEqual({
        response: 'going',
        guests: 1,
        unitId: s.home.id,
        from: 'none',
      });
    });

    it('community_event.cancelled — the reason code and how many were told', async () => {
      await e
        .http('post', `/community/events/${id}/cancel`, s.manager.token, {
          reasonCode: 'venue_unavailable',
        })
        .expect(204);
      const row = await single('community_event.cancelled', id);
      expect(row.metadata).toEqual({
        reasonCode: 'venue_unavailable',
        fromStatus: 'upcoming',
        told: 1,
      });
    });
  });

  describe('polls', () => {
    let id: string;

    it('poll.created — settings and the number of options; the question as changed', async () => {
      id = await e.poll(s.manager, {
        questionEn: `${MARKER} question?`,
        opensAt: e.at(2),
        options: [
          { labelEn: `${MARKER} one` },
          { labelEn: `${MARKER} two` },
          { labelEn: `${MARKER} three` },
        ],
      });
      const row = await single('poll.created', id);
      expect(row).toMatchObject(byManager('poll'));
      expect(row.changes).toMatchObject({
        multiple: { from: null, to: false },
        options: { from: null, to: 3 },
        questionEn: { changed: true },
      });
    });

    it('poll.changed — what moved, and that the options were replaced', async () => {
      await e
        .http('patch', `/community/polls/${id}`, s.manager.token, {
          multiple: true,
          options: [{ labelEn: `${MARKER} a` }, { labelEn: `${MARKER} b` }],
          opensAt: e.at(-1),
        })
        .expect(204);
      const row = await single('poll.changed', id);
      expect(row.changes).toMatchObject({
        multiple: { from: false, to: true },
        options: { from: 3, to: 2 },
      });
      expect(row.metadata).toEqual({ optionsReplaced: true });
    });

    it('poll.vote_cast — that the unit voted and who cast it; never what, even when changed', async () => {
      const [a, b] = await e.optionIds(s.manager, id);
      await e.vote(s.owner, id, [a]).expect(201);
      await e.vote(s.owner, id, [a, b]).expect(201);
      const found = await rows('poll.vote_cast', id);
      expect(found.map((r) => r.metadata)).toEqual([
        { unitId: s.home.id, changed: false },
        { unitId: s.home.id, changed: true },
      ]);
      expect(found[0]).toMatchObject({
        actorType: 'account',
        actorId: s.owner.id,
        targetType: 'poll',
      });
      const trail = JSON.stringify(found);
      expect(trail).not.toContain(a);
      expect(trail).not.toContain(b);
    });

    it('poll.closed — the turnout, by the staff and by the sweep', async () => {
      await e
        .http('post', `/community/polls/${id}/close`, s.manager.token)
        .expect(204);
      const row = await single('poll.closed', id);
      expect(row).toMatchObject(byManager('poll'));
      expect(row.metadata).toEqual({ turnout: 1, early: true });

      const due = await e.poll(s.manager);
      await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.poll.update({
          where: { id: due },
          data: { opensAt: e.at(-2), closesAt: e.at(-0.01) },
        }),
      );
      await e.sweep(POLL_CLOSE_SWEEP);
      const swept = await single('poll.closed', due);
      expect(swept).toMatchObject({ actorType: 'system', actorId: null });
      expect(swept.metadata).toEqual({ turnout: 0, early: false });
    });

    it('poll.cancelled — where it stood', async () => {
      const cancelled = await e.poll(s.manager);
      await e
        .http('post', `/community/polls/${cancelled}/cancel`, s.manager.token)
        .expect(204);
      const row = await single('poll.cancelled', cancelled);
      expect(row.metadata).toEqual({ fromStatus: 'open' });
    });
  });

  describe('suggestions', () => {
    let id: string;

    it('suggestion.created — the topic’s key and whether it names a unit; never the words', async () => {
      id = await e.suggestion(s.c, s.owner, {
        body: `${MARKER} my words`,
        unitId: s.home.id,
      });
      const row = await single('suggestion.created', id);
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: s.owner.id,
        targetType: 'suggestion',
      });
      expect(row.metadata).toEqual({ topicKey: 'general', withUnit: true });
    });

    it('suggestion.status_changed and .responded — from, to, and that there was an answer', async () => {
      await e
        .move(s.manager, id, 'planned', `${MARKER} the answer`)
        .expect(204);
      const moved = await single('suggestion.status_changed', id);
      expect(moved).toMatchObject(byManager('suggestion'));
      expect(moved.metadata).toEqual({
        from: 'received',
        to: 'planned',
        withResponse: true,
      });
      await e
        .http('put', `/community/suggestions/${id}/response`, s.manager.token, {
          response: `${MARKER} another answer`,
        })
        .expect(204);
      const responded = await single('suggestion.responded', id);
      expect(responded.metadata).toEqual({ status: 'planned' });
    });

    it('suggestion.published and .unpublished — never the summary', async () => {
      await e
        .publish(s.manager, id, {
          titleEn: `${MARKER} public title`,
          textEn: `${MARKER} public text`,
        })
        .expect(204);
      const published = await single('suggestion.published', id);
      expect(published.metadata).toEqual({ rewritten: false });
      await e
        .http('put', `/suggestion-board/${id}/support`, neighbour.token)
        .expect(204);
      const supported = await single('suggestion.supported', id);
      expect(supported).toMatchObject({
        actorType: 'account',
        actorId: neighbour.id,
        targetType: 'suggestion',
      });
      await e
        .http('delete', `/suggestion-board/${id}/support`, neighbour.token)
        .expect(204);
      expect(await single('suggestion.unsupported', id)).toMatchObject({
        actorId: neighbour.id,
      });
      await e
        .http('post', `/community/suggestions/${id}/unpublish`, s.manager.token)
        .expect(204);
      expect(await single('suggestion.unpublished', id)).toMatchObject(
        byManager('suggestion'),
      );
    });

    it('suggestion.done_noted — a count of photos, never the note', async () => {
      await e.move(s.manager, id, 'done').expect(204);
      const photo = await e.attachment(s.manager);
      await e
        .http(
          'put',
          `/community/suggestions/${id}/done-note`,
          s.manager.token,
          {
            noteEn: `${MARKER} what was done`,
            attachmentFileIds: [photo],
          },
        )
        .expect(204);
      const row = await single('suggestion.done_noted', id);
      expect(row.metadata).toEqual({ photos: 1 });
    });
  });

  describe('what is not audited, on purpose', () => {
    it('opening an announcement leaves no audit row: one would be the list of readers', async () => {
      const id = await e.announcement(s.manager);
      await e
        .http('post', `/announcements/${id}/read`, s.owner.token)
        .expect(204);
      const found = await read.tenant(s.c.tenantId, { targetId: id });
      expect(found.map((r) => r.action).sort()).toEqual([
        'announcement.created',
        'announcement.published',
      ]);
    });
  });

  describe('catalog completeness', () => {
    it('every community entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of ENGAGEMENT_COVERAGE) {
        expect(all).toContain(key);
        expect([
          ...COMMUNITY_COVERAGE,
          ...PHASE_2_2_COVERAGE,
          ...PHASE_4_COVERAGE,
          ...FILES_COVERAGE,
          ...MAINTENANCE_COVERAGE,
          ...PARCELS_COVERAGE,
          ...R1_COVERAGE,
          ...RESIDENT_SCREENS_COVERAGE,
          ...MANAGEMENT_COVERAGE,
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...ENGAGEMENT_COVERAGE].sort());
    });
  });
});
