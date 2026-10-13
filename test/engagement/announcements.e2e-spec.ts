import { ANNOUNCE_SWEEP } from '../../src/engagement/announcements/announcements.service';
import { gateHelpers } from '../setup/gate';
import {
  engagementHelpers,
  type EngagementSetUp,
  type Who,
} from '../setup/engagement';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Staff {
  id: string;
  status: string;
  priority: string;
  pinned: boolean;
  version: number;
  editedAt: string | null;
  notifiedAt: string | null;
  publishAt: string | null;
  titleEn: string | null;
  bodyEn: string | null;
  titleAr: string | null;
  attachmentCount: number;
  attachments?: { id: string; contentType: string; url: string | null }[];
  works: {
    areaKind: string;
    active: boolean;
    place: string | null;
    gate: { id: string; name: string; open: boolean } | null;
  } | null;
}

/**
 * ADR 0040: an announcement's life — draft, scheduled, out, edited,
 * archived — its versions, its files, works and closures as a kind of it,
 * and the read counts the staff get in place of a list of readers.
 */
describe('Community life — announcements, works and closures', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let s: EngagementSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    s = await e.setUp();
  }, 60_000);

  afterAll(() => h.close());

  const staffView = async (id: string) =>
    (
      await e
        .http('get', `/community/announcements/${id}`, s.manager.token)
        .expect(200)
    ).body as Staff;
  const patch = (id: string, body: object) =>
    e.http('patch', `/community/announcements/${id}`, s.manager.token, body);
  const publish = (id: string, body: object = {}) =>
    e.http(
      'post',
      `/community/announcements/${id}/publish`,
      s.manager.token,
      body,
    );
  const feed = async (who: Who, query = '') =>
    (
      (await e.http('get', `/announcements${query}`, who.token).expect(200))
        .body as { data: (Staff & { read: boolean; publishedAt: string })[] }
    ).data;
  const fieldsOf = (res: { body: unknown }) =>
    (res.body as { fields: unknown[] }).fields;
  /** Moves an announcement's dates in the database: the test's clock. */
  const backdate = (id: string, data: object) =>
    e.x.asManager(s.c, () =>
      e.x.prisma.tenant.announcement.update({ where: { id }, data }),
    );

  describe('from draft to archive', () => {
    it('a draft is the staff’s alone; published, its audience reads it; archived, nobody does', async () => {
      const id = await e.draft(s.manager);
      expect(await staffView(id)).toMatchObject({
        status: 'draft',
        publishAt: null,
        version: 1,
      });
      await e.http('get', `/announcements/${id}`, s.owner.token).expect(404);
      expect((await feed(s.owner)).map((a) => a.id)).not.toContain(id);

      await publish(id).expect(204);
      expect((await staffView(id)).status).toBe('published');
      const mine = (await feed(s.owner)).find((a) => a.id === id)!;
      expect(mine).toMatchObject({
        titleEn: 'Water',
        bodyEn: 'The water will be off on Friday.',
        titleAr: null,
        priority: 'normal',
        pinned: false,
        read: false,
        editedAt: null,
      });
      // What is out stays out: publishing again is not a state it takes.
      const again = await publish(id).expect(409);
      expect(again.body).toMatchObject({
        code: 'ANNOUNCEMENT_INVALID_STATE',
        params: { status: 'published' },
      });

      await e
        .http('post', `/community/announcements/${id}/archive`, s.manager.token)
        .expect(204);
      expect((await staffView(id)).status).toBe('archived');
      await e.http('get', `/announcements/${id}`, s.owner.token).expect(404);
      // Archived for good: no edit, no second archive.
      for (const res of [
        await patch(id, { bodyEn: 'Changed' }),
        await e.http(
          'post',
          `/community/announcements/${id}/archive`,
          s.manager.token,
        ),
      ])
        expect({ status: res.status, body: res.body as unknown }).toMatchObject(
          {
            status: 409,
            body: { params: { status: 'archived' } },
          },
        );
    });

    it('scheduled: nobody reads it before its time; a past time means now; the date may move until it is out', async () => {
      const id = await e.draft(s.manager);
      await publish(id, { publishAt: e.at(48) }).expect(204);
      expect((await staffView(id)).status).toBe('scheduled');
      await e.http('get', `/announcements/${id}`, s.owner.token).expect(404);
      // Moved to another day, still ahead.
      await publish(id, { publishAt: e.at(24) }).expect(204);
      expect((await staffView(id)).status).toBe('scheduled');
      // A time that has passed: out now, dated now and not then.
      await publish(id, { publishAt: e.at(-100) }).expect(204);
      const view = await staffView(id);
      expect(view.status).toBe('published');
      expect(Date.now() - new Date(view.publishAt!).getTime()).toBeLessThan(
        60_000,
      );
      await e.http('get', `/announcements/${id}`, s.owner.token).expect(200);
    });

    it('expires by itself; an expiry is a general announcement’s and comes after its publication', async () => {
      const id = await e.announcement(s.manager, { expiresAt: e.at(1) });
      await e.http('get', `/announcements/${id}`, s.owner.token).expect(200);
      await backdate(id, { publishAt: e.at(-3), expiresAt: e.at(-1) });
      expect((await staffView(id)).status).toBe('expired');
      await e.http('get', `/announcements/${id}`, s.owner.token).expect(404);

      const draft = await e.draft(s.manager, { expiresAt: e.at(1) });
      expect(
        fieldsOf(await publish(draft, { publishAt: e.at(2) }).expect(400)),
      ).toEqual([{ field: 'publishAt', code: 'ENDS_BEFORE_START' }]);
      const out = await e.announcement(s.manager);
      expect(
        fieldsOf(await patch(out, { expiresAt: e.at(-1) }).expect(400)),
      ).toEqual([{ field: 'expiresAt', code: 'ENDS_BEFORE_START' }]);
    });

    it('the staff’s list filters by status and kind, newest first', async () => {
      const draft = await e.draft(s.manager);
      const worksId = await e.works(s.manager);
      const list = async (query: string) =>
        (
          (
            await e
              .http('get', `/community/announcements${query}`, s.manager.token)
              .expect(200)
          ).body as { data: Staff[] }
        ).data;
      expect((await list('?status=draft')).map((a) => a.id)).toContain(draft);
      expect((await list('?status=draft')).map((a) => a.id)).not.toContain(
        worksId,
      );
      const works = await list('?kind=works&status=published');
      expect(works.map((a) => a.id)).toContain(worksId);
      expect(works.every((a) => a.works !== null)).toBe(true);
      const all = await list('?limit=100');
      expect(all.map((a) => a.id).indexOf(worksId)).toBeLessThan(
        all.map((a) => a.id).indexOf(draft),
      );
    });
  });

  describe('languages', () => {
    it('English, Arabic or both; a language is whole or absent; at least one', async () => {
      const post = (body: object) =>
        e.http('post', '/community/announcements', s.manager.token, {
          kind: 'general',
          ...body,
        });
      await post({
        titleAr: 'مياه',
        bodyAr: 'تنقطع المياه يوم الجمعة.',
      }).expect(201);
      await post({
        titleEn: 'Water',
        bodyEn: 'Off on Friday.',
        titleAr: 'مياه',
        bodyAr: 'تنقطع المياه يوم الجمعة.',
      }).expect(201);
      expect(fieldsOf(await post({ titleEn: 'Water' }).expect(400))).toEqual([
        { field: 'bodyEn', code: 'FIELD_REQUIRED' },
      ]);
      expect(fieldsOf(await post({}).expect(400))).toEqual([
        { field: 'titleEn', code: 'FIELD_REQUIRED' },
      ]);
      expect(
        fieldsOf(
          await post({ titleEn: 'x'.repeat(151), bodyEn: 'y' }).expect(400),
        ),
      ).toEqual([
        {
          field: 'titleEn',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 150 },
        },
      ]);
    });
  });

  describe('editing', () => {
    it('new words make a new version, the old one kept; after publication it shows as edited', async () => {
      const id = await e.draft(s.manager);
      // A draft's edit is a version too, but nobody saw the first.
      await patch(id, { bodyEn: 'The water will be off on Saturday.' }).expect(
        204,
      );
      expect(await staffView(id)).toMatchObject({ version: 2, editedAt: null });
      await publish(id).expect(204);

      await patch(id, {
        titleEn: 'Water, corrected',
        titleAr: 'مياه',
        bodyAr: 'تنقطع المياه يوم الأحد.',
      }).expect(204);
      const after = await staffView(id);
      expect(after).toMatchObject({
        version: 3,
        titleEn: 'Water, corrected',
        bodyEn: 'The water will be off on Saturday.',
        titleAr: 'مياه',
      });
      expect(after.editedAt).not.toBeNull();
      const mine = (await feed(s.owner)).find((a) => a.id === id)!;
      expect(mine.editedAt).toBe(after.editedAt);
      expect(mine.titleEn).toBe('Water, corrected');

      const versions = (
        await e
          .http(
            'get',
            `/community/announcements/${id}/versions`,
            s.manager.token,
          )
          .expect(200)
      ).body as {
        data: {
          version: number;
          bodyEn: string;
          titleAr: string | null;
          editedById: string;
        }[];
      };
      expect(
        versions.data.map((v) => [v.version, v.bodyEn, v.titleAr]),
      ).toEqual([
        [1, 'The water will be off on Friday.', null],
        [2, 'The water will be off on Saturday.', null],
        [3, 'The water will be off on Saturday.', 'مياه'],
      ]);
      expect(versions.data.every((v) => v.editedById === s.manager.id)).toBe(
        true,
      );
    });

    it('the same words again, or a change of settings alone, make no version', async () => {
      const id = await e.announcement(s.manager);
      await patch(id, { titleEn: 'Water' }).expect(204);
      await patch(id, { priority: 'important', pinnedUntil: e.at(24) }).expect(
        204,
      );
      expect(await staffView(id)).toMatchObject({
        version: 1,
        editedAt: null,
        priority: 'important',
        pinned: true,
      });
    });

    it('the audience is fixed once it is out; before that it may change', async () => {
      const id = await e.draft(s.manager);
      await patch(id, { audience: { occupancy: 'owners' } }).expect(204);
      await publish(id).expect(204);
      // The same audience again is no change.
      await patch(id, { audience: { occupancy: 'owners' } }).expect(204);
      const res = await patch(id, {
        audience: { occupancy: 'tenants' },
      }).expect(409);
      expect(res.body).toMatchObject({
        code: 'ANNOUNCEMENT_INVALID_STATE',
        params: { status: 'published' },
      });
    });
  });

  describe('priority and pin', () => {
    it('only an important announcement is pinned; the pin ends by itself and goes with the priority', async () => {
      expect(
        fieldsOf(
          await e
            .http('post', '/community/announcements', s.manager.token, {
              kind: 'general',
              titleEn: 'x',
              bodyEn: 'y',
              pinnedUntil: e.at(1),
            })
            .expect(400),
        ),
      ).toEqual([{ field: 'pinnedUntil', code: 'FIELD_NOT_ALLOWED' }]);

      const id = await e.announcement(s.manager, {
        priority: 'important',
        pinnedUntil: e.at(1),
      });
      expect((await feed(s.owner, '?pinned=true')).map((a) => a.id)).toContain(
        id,
      );
      await backdate(id, { pinnedUntil: e.at(-1) });
      expect((await staffView(id)).pinned).toBe(false);
      expect(
        (await feed(s.owner, '?pinned=true')).map((a) => a.id),
      ).not.toContain(id);
      // Still in the feed, just not on top.
      expect((await feed(s.owner)).map((a) => a.id)).toContain(id);

      const pinned = await e.announcement(s.manager, {
        priority: 'important',
        pinnedUntil: e.at(1),
      });
      await patch(pinned, { priority: 'normal' }).expect(204);
      expect(await staffView(pinned)).toMatchObject({
        priority: 'normal',
        pinned: false,
      });
    });

    it('a scheduled important announcement tells its audience when its time comes, once, by the sweep', async () => {
      const id = await e.draft(s.manager, { priority: 'important' });
      await publish(id, { publishAt: e.at(1) }).expect(204);
      const told = () =>
        e.notifications(s.c, s.owner.id, 'community_announcement.important');
      const before = (await told()).length;
      expect(await e.sweep(ANNOUNCE_SWEEP)).toBe(0);
      expect((await told()).length).toBe(before);

      await backdate(id, { publishAt: e.at(-0.1) });
      expect(await e.sweep(ANNOUNCE_SWEEP)).toBe(1);
      expect(await e.sweep(ANNOUNCE_SWEEP)).toBe(0);
      const mine = (await told()).filter((n) => n.targetId === id);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        targetType: 'community_announcement',
        params: {},
      });
      expect((await staffView(id)).notifiedAt).not.toBeNull();
    });
  });

  describe('attachments', () => {
    it('images and a PDF, up to five; a version shows the files it had', async () => {
      const png = await e.attachment(s.manager);
      const pdf = await e.attachment(s.manager, 'application/pdf');
      const id = await e.announcement(s.manager, {
        attachmentFileIds: [png, pdf],
      });
      const first = await staffView(id);
      expect(first.attachments!.map((a) => a.contentType)).toEqual([
        'image/png',
        'application/pdf',
      ]);
      expect(first.attachments!.every((a) => a.url)).toBe(true);
      // The resident gets the same files, with URLs of their own.
      const mine = (
        await e.http('get', `/announcements/${id}`, s.owner.token).expect(200)
      ).body as Staff;
      expect(mine.attachments).toHaveLength(2);
      expect(await fetch(mine.attachments![0].url!).then((r) => r.status)).toBe(
        200,
      );

      // Keep the PDF, drop the image, add another: a new version.
      const another = await e.attachment(s.manager, 'image/jpeg');
      await patch(id, {
        attachmentFileIds: [first.attachments![1].id, another],
      }).expect(204);
      const second = await staffView(id);
      expect(second.version).toBe(2);
      expect(second.attachments!.map((a) => a.contentType)).toEqual([
        'application/pdf',
        'image/jpeg',
      ]);
      const versions = (
        await e
          .http(
            'get',
            `/community/announcements/${id}/versions`,
            s.manager.token,
          )
          .expect(200)
      ).body as { data: { attachments: { contentType: string }[] }[] };
      expect(
        versions.data.map((v) => v.attachments.map((a) => a.contentType)),
      ).toEqual([
        ['image/png', 'application/pdf'],
        ['application/pdf', 'image/jpeg'],
      ]);
    });

    it('a file is the caller’s own, finalized, of the right purpose, and used once', async () => {
      const used = await e.attachment(s.manager);
      await e.draft(s.manager, { attachmentFileIds: [used] });
      const other = await e.staff(s.c, ['community.publish']);
      const theirs = await e.attachment(other);
      for (const fileId of [used, theirs])
        expect(
          fieldsOf(
            await e
              .http('post', '/community/announcements', s.manager.token, {
                kind: 'general',
                titleEn: 'x',
                bodyEn: 'y',
                attachmentFileIds: [fileId],
              })
              .expect(400),
          ),
        ).toEqual([
          { field: 'attachmentFileIds.0', code: 'FILE_NOT_AVAILABLE' },
        ]);
      // A resident cannot upload one at all.
      await h
        .http()
        .post('/api/v1/files/uploads')
        .set('Authorization', `Bearer ${s.owner.token}`)
        .send({
          purpose: 'community_attachment',
          contentType: 'image/png',
          size: 48,
        })
        .expect(403);
    });
  });

  describe('works and closures', () => {
    it('a kind of announcement with dates and an area; under way from start to end, gone by itself after', async () => {
      const id = await e.works(s.manager, {
        works: {
          startsAt: e.at(1),
          endsAt: e.at(3),
          areaKind: 'facility',
          place: 'The pool',
        },
      });
      const upcoming = (
        await e.http('get', `/announcements/${id}`, s.owner.token).expect(200)
      ).body as Staff;
      expect(upcoming.works).toMatchObject({
        areaKind: 'facility',
        place: 'The pool',
        active: false,
        gate: null,
      });
      await backdate(id, { worksStartsAt: e.at(-1) });
      expect(
        (await feed(s.owner, '?kind=works')).find((a) => a.id === id)!.works!
          .active,
      ).toBe(true);
      await backdate(id, {
        publishAt: e.at(-5),
        worksStartsAt: e.at(-3),
        worksEndsAt: e.at(-1),
      });
      expect((await staffView(id)).status).toBe('ended');
      await e.http('get', `/announcements/${id}`, s.owner.token).expect(404);
      expect((await feed(s.owner)).map((a) => a.id)).not.toContain(id);
    });

    it('works at a gate name one of the compound’s gates, and show whether it is in service', async () => {
      const gate = await gateHelpers(h).gate(s.c);
      const id = await e.works(s.manager, {
        works: {
          startsAt: e.at(-1),
          endsAt: e.at(2),
          areaKind: 'gate',
          gateId: gate.id,
        },
      });
      const view = (
        await e.http('get', `/announcements/${id}`, s.owner.token).expect(200)
      ).body as Staff;
      expect(view.works!.gate).toEqual({
        id: gate.id,
        name: gate.name,
        open: true,
      });
      const post = (works: object) =>
        e.http('post', '/community/announcements', s.manager.token, {
          kind: 'works',
          titleEn: 'x',
          bodyEn: 'y',
          works,
        });
      // Another compound's gate, or none at all: not a gate of this one.
      const other = await e.x.compound();
      const theirs = await gateHelpers(h).gate(other);
      expect(
        fieldsOf(
          await post({
            startsAt: e.at(1),
            endsAt: e.at(2),
            areaKind: 'gate',
            gateId: theirs.id,
          }).expect(400),
        ),
      ).toEqual([{ field: 'works.gateId', code: 'INVALID_VALUE' }]);
      expect(
        fieldsOf(
          await post({
            startsAt: e.at(1),
            endsAt: e.at(2),
            areaKind: 'road',
            gateId: gate.id,
          }).expect(400),
        ),
      ).toEqual([{ field: 'works.gateId', code: 'FIELD_NOT_ALLOWED' }]);
    });

    it('works need their dates in order; a general announcement takes none; works take no expiry', async () => {
      const post = (body: object) =>
        e.http('post', '/community/announcements', s.manager.token, {
          titleEn: 'x',
          bodyEn: 'y',
          ...body,
        });
      expect(fieldsOf(await post({ kind: 'works' }).expect(400))).toEqual([
        { field: 'works', code: 'FIELD_REQUIRED' },
      ]);
      const works = { startsAt: e.at(2), endsAt: e.at(1), areaKind: 'road' };
      expect(
        fieldsOf(await post({ kind: 'works', works }).expect(400)),
      ).toEqual([{ field: 'works.endsAt', code: 'ENDS_BEFORE_START' }]);
      expect(
        fieldsOf(
          await post({
            kind: 'general',
            works: { ...works, endsAt: e.at(3) },
          }).expect(400),
        ),
      ).toEqual([{ field: 'works', code: 'FIELD_NOT_ALLOWED' }]);
      expect(
        fieldsOf(
          await post({
            kind: 'works',
            works: { ...works, endsAt: e.at(3) },
            expiresAt: e.at(5),
          }).expect(400),
        ),
      ).toEqual([{ field: 'expiresAt', code: 'FIELD_NOT_ALLOWED' }]);
    });
  });

  describe('read counts', () => {
    it('the staff see how many accounts and units opened it, never who; marking twice counts once', async () => {
      const second = await e.family(s.c, s.home.id, s.owner);
      const elsewhere = await e.owner(s.c, (await e.unit(s.c, 'A')).id);
      const id = await e.announcement(s.manager);
      const counts = async () =>
        (
          await e
            .http(
              'get',
              `/community/announcements/${id}/reads`,
              s.manager.token,
            )
            .expect(200)
        ).body as Record<string, number>;
      expect(await counts()).toMatchObject({ accounts: 0, units: 0 });

      const read = (who: Who) =>
        e.http('post', `/announcements/${id}/read`, who.token).expect(204);
      await read(s.owner);
      await read(s.owner);
      expect(await counts()).toMatchObject({ accounts: 1, units: 1 });
      // A second reader of the same home: one more account, the same unit.
      await read(second);
      expect(await counts()).toMatchObject({ accounts: 2, units: 1 });
      await read(elsewhere);
      const final = await counts();
      expect(final).toMatchObject({ accounts: 3, units: 2 });
      expect(Object.keys(final).sort()).toEqual([
        'accounts',
        'audienceAccounts',
        'audienceUnits',
        'units',
      ]);

      // Each reader is told their own "read", and nobody else's.
      expect((await feed(s.owner)).find((a) => a.id === id)!.read).toBe(true);
      const stranger = await e.owner(s.c, (await e.unit(s.c, 'A')).id);
      expect((await feed(stranger)).find((a) => a.id === id)!.read).toBe(false);
    });

    it('what is stored cannot name a reader: keyed hashes, no account, no unit, no time; and nothing is audited', async () => {
      const id = await e.announcement(s.manager);
      await e
        .http('post', `/announcements/${id}/read`, s.owner.token)
        .expect(204);
      const columns = await e.inTx(
        s.c,
        (tx) => tx.$queryRaw<{ column_name: string }[]>`
          SELECT column_name::text FROM information_schema.columns
           WHERE table_name = 'announcement_read_marks' ORDER BY 1`,
      );
      expect(columns.map((c) => c.column_name)).toEqual([
        'announcement_id',
        'kind',
        'ref',
        'tenant_id',
      ]);
      const marks = await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.announcementReadMark.findMany({
          where: { announcementId: id },
        }),
      );
      expect(marks.map((m) => m.kind).sort()).toEqual(['account', 'unit']);
      const hex = marks
        .map((m) => Buffer.from(m.ref).toString('hex'))
        .join(' ');
      for (const subject of [s.owner.id, s.home.id])
        expect(hex).not.toContain(subject.replace(/-/g, ''));
      const audit = await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.auditLog.findMany({ where: { targetId: id } }),
      );
      expect(audit.filter((r) => r.actorId === s.owner.id)).toEqual([]);
    });

    it('only what the caller can read can be marked', async () => {
      const draft = await e.draft(s.manager);
      const owners = await e.announcement(s.manager, {
        audience: { occupancy: 'tenants' },
      });
      for (const id of [draft, owners])
        await e
          .http('post', `/announcements/${id}/read`, s.owner.token)
          .expect(404);
    });
  });
});
