import {
  engagementHelpers,
  type EngagementSetUp,
  type Who,
} from '../setup/engagement';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0080: an announcement put to single units, its delivery counted, one
 * reminder to whoever has not opened it (exactly once, also when two staff
 * send it at once), and the compound's announcement templates.
 */
describe('Announcements — single units, delivery, one reminder, templates', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let s: EngagementSetUp;
  let other: Who;
  let otherUnit: { id: string };

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    s = await e.setUp();
    otherUnit = await e.unit(s.c, 'A');
    other = await e.owner(s.c, otherUnit.id);
  }, 60_000);

  afterAll(() => h.close());

  const fieldsOf = (res: { body: unknown }) =>
    (res.body as { fields: unknown[] }).fields;
  const feed = async (who: Who) =>
    (
      (await e.http('get', '/announcements', who.token).expect(200)).body as {
        data: { id: string }[];
      }
    ).data.map((a) => a.id);
  const delivery = async (id: string) =>
    (
      await e
        .http('get', `/community/announcements/${id}/delivery`, s.manager.token)
        .expect(200)
    ).body as Record<string, unknown> & { opened: Record<string, number> };
  const remind = (id: string) =>
    e.http('post', `/community/announcements/${id}/remind`, s.manager.token);

  describe('to single units', () => {
    it('reaches the people of the named units only, in the feed and by id; the staff see the units and their codes', async () => {
      const id = await e.announcement(s.manager, {
        audience: { occupancy: 'everyone', unitIds: [s.home.id] },
      });
      expect(await feed(s.owner)).toContain(id);
      expect(await feed(other)).not.toContain(id);
      await e.http('get', `/announcements/${id}`, s.owner.token).expect(200);
      await e.http('get', `/announcements/${id}`, other.token).expect(404);
      const staff = (
        await e
          .http('get', `/community/announcements/${id}`, s.manager.token)
          .expect(200)
      ).body as {
        audience: { unitIds: string[] | null; buildings: string[] | null };
        audienceUnitCodes: string[];
      };
      expect(staff.audience).toMatchObject({
        unitIds: [s.home.id],
        buildings: null,
      });
      expect(staff.audienceUnitCodes).toHaveLength(1);
    });

    it('a unit audience within an occupancy keeps to it', async () => {
      const id = await e.announcement(s.manager, {
        audience: { occupancy: 'tenants', unitIds: [s.home.id] },
      });
      // The home unit's owner is no tenant.
      expect(await feed(s.owner)).not.toContain(id);
    });

    it('never beside buildings, and only the compound’s units', async () => {
      const both = await e
        .http('post', '/community/announcements', s.manager.token, {
          kind: 'general',
          titleEn: 'Both',
          bodyEn: 'Both.',
          audience: {
            occupancy: 'everyone',
            buildings: ['A'],
            unitIds: [s.home.id],
          },
        })
        .expect(400);
      expect(fieldsOf(both)).toEqual([
        { field: 'audience.unitIds', code: 'FIELD_NOT_ALLOWED' },
      ]);
      const unknown = await e
        .http('post', '/community/announcements', s.manager.token, {
          kind: 'general',
          titleEn: 'Unknown',
          bodyEn: 'Unknown.',
          audience: {
            occupancy: 'everyone',
            unitIds: [s.home.id, '00000000-0000-4000-8000-000000000000'],
          },
        })
        .expect(400);
      expect(fieldsOf(unknown)).toEqual([
        { field: 'audience.unitIds.1', code: 'INVALID_VALUE' },
      ]);
    });

    it('the preview counts a unit audience', async () => {
      const res = await e
        .http('post', '/community/audience/preview', s.manager.token, {
          audience: { occupancy: 'everyone', unitIds: [s.home.id] },
        })
        .expect(200);
      expect(res.body).toEqual({ units: 1, accounts: 1 });
    });
  });

  describe('delivery and the one reminder', () => {
    it('counts the notice’s inbox rows, who read them and who opened it; the reminder tells only who has not opened it, once', async () => {
      const id = await e.announcement(s.manager, {
        priority: 'important',
        audience: { occupancy: 'everyone', buildings: ['A'] },
      });
      expect(await delivery(id)).toMatchObject({
        notified: 2,
        reminded: 0,
        remindedAt: null,
        opened: { accounts: 0, audienceAccounts: 2 },
      });
      await e
        .http('post', `/announcements/${id}/read`, s.owner.token)
        .expect(204);
      const sent = await remind(id).expect(200);
      expect(sent.body).toEqual({ recipients: 1 });
      const told = await e.notifications(
        s.c,
        other.id,
        'community_announcement.reminder',
      );
      expect(told.filter((n) => n.targetId === id)).toHaveLength(1);
      expect(
        (
          await e.notifications(
            s.c,
            s.owner.id,
            'community_announcement.reminder',
          )
        ).filter((n) => n.targetId === id),
      ).toEqual([]);
      expect(await delivery(id)).toMatchObject({
        notified: 2,
        reminded: 1,
        opened: { accounts: 1 },
      });
      const again = await remind(id).expect(409);
      expect(again.body).toMatchObject({
        code: 'ANNOUNCEMENT_ALREADY_REMINDED',
      });
    });

    it('two reminders at once: one goes, the other is refused, and nobody is told twice', async () => {
      const id = await e.announcement(s.manager, {
        audience: { occupancy: 'everyone', buildings: ['A'] },
      });
      const [a, b] = await Promise.all([remind(id), remind(id)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      for (const who of [s.owner, other])
        expect(
          (
            await e.notifications(
              s.c,
              who.id,
              'community_announcement.reminder',
            )
          ).filter((n) => n.targetId === id),
        ).toHaveLength(1);
    });

    it('only an announcement that is out is reminded', async () => {
      const id = await e.draft(s.manager);
      expect((await remind(id).expect(409)).body).toMatchObject({
        code: 'ANNOUNCEMENT_INVALID_STATE',
        params: { status: 'draft' },
      });
    });

    it('a resident neither reads the delivery nor reminds', async () => {
      const id = await e.announcement(s.manager);
      await e
        .http('get', `/community/announcements/${id}/delivery`, s.owner.token)
        .expect(403);
      await e
        .http('post', `/community/announcements/${id}/remind`, s.owner.token)
        .expect(403);
    });
  });

  describe('templates', () => {
    it('are added, changed, listed by name and deleted; a name once a compound', async () => {
      const path = '/community/announcement-templates';
      const created = await e
        .http('post', path, s.manager.token, {
          name: 'Water cut',
          titleEn: 'Water cut',
          bodyEn: 'The water is off on [day].',
        })
        .expect(201);
      const id = (created.body as { id: string }).id;
      const twin = await e
        .http('post', path, s.manager.token, {
          name: 'Water cut',
          titleAr: 'انقطاع المياه',
          bodyAr: 'تنقطع المياه يوم [اليوم].',
        })
        .expect(409);
      expect(twin.body).toMatchObject({ code: 'DUPLICATE_RESOURCE' });
      const half = await e
        .http('post', path, s.manager.token, { name: 'Half', titleEn: 'x' })
        .expect(400);
      expect(fieldsOf(half)).toEqual([
        { field: 'bodyEn', code: 'FIELD_REQUIRED' },
      ]);
      await e
        .http('patch', `${path}/${id}`, s.manager.token, {
          titleAr: 'انقطاع المياه',
          bodyAr: 'تنقطع المياه.',
        })
        .expect(200);
      const list = (
        (await e.http('get', path, s.manager.token).expect(200)).body as {
          data: { id: string; titleAr: string | null }[];
        }
      ).data;
      expect(list.find((t) => t.id === id)?.titleAr).toBe('انقطاع المياه');
      await e.http('delete', `${path}/${id}`, s.manager.token).expect(204);
      await e.http('delete', `${path}/${id}`, s.manager.token).expect(404);
      await e.http('get', path, s.owner.token).expect(403);
    });
  });
});
