import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  managementHelpers,
  type ManagementSetUp,
  type Who,
} from '../setup/management';

/**
 * ADR 0039: opening a request, by its author or by staff on the author's
 * behalf; who sees it (its author alone on the resident side); the staff
 * inbox and its filters; and assignment.
 */
describe('Management requests — opening, reading and assigning', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof managementHelpers>;
  let s: ManagementSetUp;
  let family: Who;
  let neighbour: Who;
  let handler: Who;
  let otherUnitId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = managementHelpers(h);
    s = await m.setUp();
    const member = await m.x.joinFamily(s.c, s.unit.id, s.owner);
    family = await m.who(s.c, member.id, 'family');
    const other = await m.x.unit(s.c);
    otherUnitId = other.id;
    neighbour = await m.who(
      s.c,
      (await m.x.resident(s.c, [other.id])).id,
      'resident',
    );
    handler = await m.handler(s.c);
  }, 120_000);

  afterAll(() => h.close());

  type Item = {
    id: string;
    number: string;
    status: string;
    type: string;
    topic: { key: string };
    unit: { id: string; code: string } | null;
    author?: { id: string; fullName?: string };
    assignee?: { id: string } | null;
    preview?: string | null;
    [key: string]: unknown;
  };
  const list = async (path: string, token: string) =>
    ((await m.http('get', path, token).expect(200)).body as { data: Item[] })
      .data;

  describe('opening', () => {
    it('the author opens one, with a unit of theirs or without; it starts open, numbered from 1', async () => {
      const first = await m.open(s.c, s.owner, {
        unitId: s.unit.id,
        body: '  When is the pool open?  ',
      });
      expect(first).toEqual({
        id: expect.any(String) as string,
        number: 'MR-000001',
        status: 'open',
        createdAt: expect.any(String) as string,
      });
      const second = await m.open(s.c, s.owner, { type: 'general' });
      expect(second.number).toBe('MR-000002');

      const res = await m
        .http('get', `/management-requests/${first.id}`, s.owner.token)
        .expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.body as Item;
      expect(body).toMatchObject({
        id: first.id,
        number: 'MR-000001',
        type: 'question',
        status: 'open',
        topic: { key: 'general', nameEn: 'General' },
        unit: { id: s.unit.id, code: s.unit.code },
        cycle: 1,
        openedByManagement: false,
        closedAt: null,
        closeReason: null,
        reopenUntil: null,
      });
      // The topic's target is 48 hours from the creation, to the millisecond.
      expect(
        new Date(body.responseDueAt as string).getTime() -
          new Date(body.createdAt as string).getTime(),
      ).toBe(48 * 3_600_000);
      // Nothing of the staff's side: who handles it, how the clock stands.
      for (const key of [
        'author',
        'assignee',
        'openedBy',
        'overdue',
        'escalatedAt',
        'preview',
        'firstResponseAt',
      ])
        expect(body).not.toHaveProperty(key);
    });

    it('a family member and a landlord are authors too', async () => {
      const mine = await m.open(s.c, family, { unitId: s.unit.id });
      expect(mine.status).toBe('open');
      // A landlord: owns the unit and does not live in it.
      const rented = await m.x.unit(s.c);
      const owner = await m.x.asManager(s.c, () =>
        m.x.residents.createResident({
          ...m.x.person('landlord'),
          units: [
            { unitId: rented.id, occupancyType: 'owner', resides: false },
          ],
        }),
      );
      const landlord = await m.who(s.c, owner.id, 'resident');
      const theirs = await m.open(s.c, landlord, { unitId: rented.id });
      expect(theirs.status).toBe('open');
    });

    it('a unit that is not the author’s is "not found", like one that does not exist', async () => {
      const topicId = await m.topicId(s.c);
      for (const unitId of [
        otherUnitId,
        '7b0e7a5e-1c1b-4d7f-9a53-1e6d6f3c2a10',
      ]) {
        const res = await m
          .http('post', '/management-requests', s.owner.token, {
            type: 'question',
            topicId,
            unitId,
            body: 'About a unit',
          })
          .expect(404);
        expect(res.body).toMatchObject({ code: 'UNIT_NOT_FOUND' });
      }
    });

    it('the topic is an active one of the compound; an appointment is not opened without its slot', async () => {
      const retired = await m
        .http('post', '/management/request-topics', s.manager.token, {
          key: 'retired',
          nameAr: 'قديم',
          nameEn: 'Retired',
          targetResponseHours: 1,
        })
        .expect(201);
      const retiredId = (retired.body as { id: string }).id;
      await m
        .http(
          'patch',
          `/management/request-topics/${retiredId}`,
          s.manager.token,
          { active: false },
        )
        .expect(200);
      const other = await m.setUp();
      for (const topicId of [retiredId, await m.topicId(other.c)]) {
        const res = await m
          .http('post', '/management-requests', s.owner.token, {
            type: 'question',
            topicId,
            body: 'Hello',
          })
          .expect(400);
        expect(res.body).toMatchObject({
          code: 'VALIDATION_FAILED',
          fields: [{ field: 'topicId', code: 'TOPIC_NOT_AVAILABLE' }],
        });
      }
      const res = await m
        .http('post', '/management-requests', s.owner.token, {
          type: 'appointment',
          topicId: await m.topicId(s.c),
          body: 'Hello',
        })
        .expect(400);
      // An appointment names its slot: it is not opened by writing alone.
      expect(res.body).toMatchObject({
        fields: [{ field: 'appointment', code: 'FIELD_REQUIRED' }],
      });
    });

    it('staff do not open requests as residents, and residents not as staff', async () => {
      await m
        .http('post', '/management-requests', s.manager.token, {
          type: 'question',
          topicId: await m.topicId(s.c),
          body: 'Hello',
        })
        .expect(403);
      await m.http('get', '/management-requests', handler.token).expect(403);
      await m.http('get', '/management/requests', s.owner.token).expect(403);
    });

    it('the same Idempotency-Key opens one request and answers the same twice', async () => {
      const topicId = await m.topicId(s.c);
      const post = () =>
        m.http(
          'post',
          '/management-requests',
          neighbour.token,
          { type: 'general', topicId, body: 'Once' },
          { 'Idempotency-Key': 'r2-open-once-0001' },
        );
      const first = await post().expect(201);
      const second = await post().expect(201);
      expect(second.body).toEqual(first.body);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(await list('/management-requests', neighbour.token)).toHaveLength(
        1,
      );
    });
  });

  describe('privacy on the resident side', () => {
    let ownersId: string;
    let familysId: string;

    beforeAll(async () => {
      ownersId = (await m.open(s.c, s.owner, { unitId: s.unit.id })).id;
      familysId = (await m.open(s.c, family, { unitId: s.unit.id })).id;
    });

    it('a request is its author’s alone: the primary does not see a family member’s, nor the member the primary’s', async () => {
      const owners = await list('/management-requests', s.owner.token);
      const familys = await list('/management-requests', family.token);
      expect(owners.map((r) => r.id)).toContain(ownersId);
      expect(owners.map((r) => r.id)).not.toContain(familysId);
      expect(familys.map((r) => r.id)).toContain(familysId);
      expect(familys.map((r) => r.id)).not.toContain(ownersId);
    });

    it('by id it is "not found" for anyone else: the household, a neighbour, another compound', async () => {
      const other = await m.setUp();
      for (const [who, id] of [
        [s.owner, familysId],
        [family, ownersId],
        [neighbour, ownersId],
        [other.owner, ownersId],
      ] as const) {
        const res = await m
          .http('get', `/management-requests/${id}`, who.token)
          .expect(404);
        expect(res.body).toMatchObject({
          code: 'MANAGEMENT_REQUEST_NOT_FOUND',
        });
      }
      // Another compound's staff neither.
      await m
        .http('get', `/management/requests/${ownersId}`, other.manager.token)
        .expect(404);
    });
  });

  describe('the staff inbox', () => {
    it('shows every request with its author, by last activity, newest first', async () => {
      const mine = await list('/management/requests', handler.token);
      const all = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.managementRequest.findMany({
          orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        }),
      );
      expect(mine.map((r) => r.id)).toEqual(all.map((r) => r.id));
      const authors = new Set(mine.map((r) => r.author?.id));
      for (const who of [s.owner, family, neighbour])
        expect(authors).toContain(who.id);
      expect(mine[0].author).toEqual({
        id: expect.any(String) as string,
        fullName: expect.any(String) as string,
      });
      expect(mine[0]).toMatchObject({
        assignee: null,
        overdue: false,
        escalatedAt: null,
        firstResponseAt: null,
        openedBy: null,
        onBehalfReason: null,
      });
    });

    it('carries a preview of the first message: 120 characters, as written', async () => {
      const long = `${'x'.repeat(119)}YZ and the rest`;
      const { id } = await m.open(s.c, neighbour, { body: long });
      const [row] = (await list('/management/requests', handler.token)).filter(
        (r) => r.id === id,
      );
      expect(row.preview).toBe(`${'x'.repeat(119)}Y`);
      // The detail and the resident's list carry none.
      const detail = await m
        .http('get', `/management/requests/${id}`, handler.token)
        .expect(200);
      expect(detail.body).not.toHaveProperty('preview');
      for (const r of await list('/management-requests', neighbour.token))
        expect(r).not.toHaveProperty('preview');
    });

    it('pages by keyset without a gap or a repeat', async () => {
      const all = await list('/management/requests?limit=100', handler.token);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await m
          .http(
            'get',
            `/management/requests?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
            handler.token,
          )
          .expect(200);
        const page = res.body as { data: Item[]; nextCursor: string | null };
        seen.push(...page.data.map((r) => r.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(all.map((r) => r.id));
    });

    it('filters by type, topic and status', async () => {
      const billing = await m.topicId(s.c, 'billing_fees');
      const { id } = await m.open(s.c, neighbour, {
        type: 'general',
        topicId: billing,
      });
      const byTopic = await list(
        `/management/requests?topicId=${billing}`,
        handler.token,
      );
      expect(byTopic.map((r) => r.id)).toEqual([id]);
      const general = await list(
        '/management/requests?type=general&limit=100',
        handler.token,
      );
      expect(general.length).toBeGreaterThan(0);
      expect(new Set(general.map((r) => r.type))).toEqual(new Set(['general']));
      expect(
        await list('/management/requests?status=closed', handler.token),
      ).toEqual([]);
      // "Open" is everything not closed, decided by the API.
      await m
        .http('post', `/management/requests/${id}/close`, handler.token, {
          reasonCode: 'duplicate',
        })
        .expect(204);
      const open = await list(
        '/management/requests?open=true&limit=100',
        handler.token,
      );
      expect(open.map((r) => r.id)).not.toContain(id);
      expect(open.length).toBeGreaterThan(0);
      expect(new Set(open.map((r) => r.status))).not.toContain('closed');
      expect(
        (await list('/management/requests?status=closed', handler.token)).map(
          (r) => r.id,
        ),
      ).toEqual([id]);
      const bad = await m
        .http('get', '/management/requests?assignee=somebody', handler.token)
        .expect(400);
      expect(bad.body).toMatchObject({
        fields: [{ field: 'assignee', code: 'INVALID_FORMAT' }],
      });
    });
  });

  describe('on behalf', () => {
    const body = async (over: Record<string, unknown> = {}) => ({
      type: 'general',
      topicId: await m.topicId(s.c, 'documents'),
      authorAccountId: s.owner.id,
      reasonCode: 'resident_walk_in',
      body: 'The resident asked at the desk for a letter.',
      ...over,
    });

    it('the unit’s people are whom a request may be opened for there', async () => {
      const res = await m
        .http(
          'get',
          `/management/units/${s.unit.id}/request-authors`,
          s.manager.token,
        )
        .expect(200);
      const { data } = res.body as { data: { id: string; fullName: string }[] };
      expect(data.map((p) => p.id).sort()).toEqual(
        [s.owner.id, family.id].sort(),
      );
      expect(Object.keys(data[0]).sort()).toEqual(['fullName', 'id']);
      // It names residents: requests.handle alone is not enough.
      await m
        .http(
          'get',
          `/management/units/${s.unit.id}/request-authors`,
          handler.token,
        )
        .expect(403);
    });

    it('the resident is the author and sees it; who opened it and why are kept', async () => {
      const res = await m
        .http(
          'post',
          '/management/requests',
          s.manager.token,
          await body({ unitId: s.unit.id }),
        )
        .expect(201);
      const { id } = res.body as { id: string };
      const mine = await m
        .http('get', `/management-requests/${id}`, s.owner.token)
        .expect(200);
      expect(mine.body).toMatchObject({
        id,
        openedByManagement: true,
        status: 'open',
        unit: { id: s.unit.id },
      });
      expect(mine.body).not.toHaveProperty('onBehalfReason');
      const staff = await m
        .http('get', `/management/requests/${id}`, handler.token)
        .expect(200);
      expect(staff.body).toMatchObject({
        author: { id: s.owner.id },
        openedBy: { id: s.manager.id },
        onBehalfReason: 'resident_walk_in',
        // Taking a request down is not answering it.
        firstResponseAt: null,
        status: 'open',
      });
    });

    it('the reason is required, from the closed list', async () => {
      const missing = await m
        .http(
          'post',
          '/management/requests',
          s.manager.token,
          await body({ reasonCode: undefined }),
        )
        .expect(400);
      expect(missing.body).toMatchObject({
        fields: [{ field: 'reasonCode' }],
      });
      const unknown = await m
        .http(
          'post',
          '/management/requests',
          s.manager.token,
          await body({ reasonCode: 'felt_like_it' }),
        )
        .expect(400);
      expect(unknown.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: [
          {
            field: 'reasonCode',
            code: 'INVALID_REASON_CODE',
            params: {
              allowed: [
                'resident_phone_call',
                'resident_walk_in',
                'resident_written_letter',
              ],
            },
          },
        ],
      });
    });

    it('only for an active resident or family account, and only with a unit of theirs', async () => {
      const other = await m.setUp();
      for (const authorAccountId of [
        s.manager.id,
        handler.id,
        other.owner.id,
        '7b0e7a5e-1c1b-4d7f-9a53-1e6d6f3c2a10',
      ]) {
        const res = await m
          .http(
            'post',
            '/management/requests',
            s.manager.token,
            await body({ authorAccountId }),
          )
          .expect(400);
        expect(res.body).toMatchObject({
          fields: [{ field: 'authorAccountId', code: 'AUTHOR_NOT_ELIGIBLE' }],
        });
      }
      const res = await m
        .http(
          'post',
          '/management/requests',
          s.manager.token,
          await body({ unitId: otherUnitId }),
        )
        .expect(404);
      expect(res.body).toMatchObject({ code: 'UNIT_NOT_FOUND' });
    });

    it('a handler without residents.read cannot open one for a resident', async () => {
      await m
        .http('post', '/management/requests', handler.token, await body())
        .expect(403);
    });
  });

  describe('assignment', () => {
    let id: string;
    const assign = (assigneeId: string | null, token = s.manager.token) =>
      m.http('post', `/management/requests/${id}/assign`, token, {
        assigneeId,
      });
    const assignee = async () =>
      (
        (
          await m
            .http('get', `/management/requests/${id}`, s.manager.token)
            .expect(200)
        ).body as Item
      ).assignee;

    beforeAll(async () => {
      id = (await m.open(s.c, neighbour)).id;
    });

    it('the handlers of the compound are whom a request may be given to', async () => {
      const res = await m
        .http('get', '/management/request-assignees', handler.token)
        .expect(200);
      const { data } = res.body as { data: { id: string }[] };
      expect(data.map((p) => p.id).sort()).toEqual(
        [s.manager.id, handler.id].sort(),
      );
    });

    it('to a handler, to oneself, and back to the queue', async () => {
      await assign(handler.id).expect(204);
      expect(await assignee()).toMatchObject({ id: handler.id });
      await assign(handler.id, handler.token).expect(204);
      await assign(s.manager.id, handler.token).expect(204);
      expect(await assignee()).toMatchObject({ id: s.manager.id });
      await assign(null).expect(204);
      expect(await assignee()).toBeNull();
    });

    it('the inbox filters by assignee: an account, me, and nobody', async () => {
      await assign(handler.id).expect(204);
      const ids = async (query: string, token: string) =>
        (await list(`/management/requests?${query}&limit=100`, token)).map(
          (r) => r.id,
        );
      expect(await ids('assignee=me', handler.token)).toEqual([id]);
      expect(await ids(`assignee=${handler.id}`, s.manager.token)).toEqual([
        id,
      ]);
      expect(await ids('assignee=me', s.manager.token)).toEqual([]);
      const unassigned = await ids('assignee=none', s.manager.token);
      expect(unassigned).not.toContain(id);
      expect(unassigned.length).toBeGreaterThan(0);
    });

    it('never to someone who does not handle requests', async () => {
      const other = await m.setUp();
      for (const assigneeId of [
        s.owner.id,
        other.manager.id,
        '7b0e7a5e-1c1b-4d7f-9a53-1e6d6f3c2a10',
      ]) {
        const res = await assign(assigneeId).expect(400);
        expect(res.body).toMatchObject({
          fields: [{ field: 'assigneeId', code: 'ASSIGNEE_NOT_ELIGIBLE' }],
        });
      }
      expect(await assignee()).toMatchObject({ id: handler.id });
    });

    it('a resident cannot assign, and another compound’s request is not found', async () => {
      await assign(handler.id, s.owner.token).expect(403);
      const other = await m.setUp();
      const res = await assign(other.manager.id, other.manager.token).expect(
        404,
      );
      expect(res.body).toMatchObject({ code: 'MANAGEMENT_REQUEST_NOT_FOUND' });
    });
  });
});
