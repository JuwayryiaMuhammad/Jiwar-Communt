import { newId } from '../../src/core/common/uuid';
import { engagementHelpers, type EngagementSetUp } from '../setup/engagement';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { managementHelpers } from '../setup/management';

interface StaffRequest {
  id: string;
  number: string;
  status: string;
  topic: { key: string };
  outreach: boolean;
  closeReason: string | null;
  convertedTicket: { id: string; number: string | null } | null;
  responseDueAt: string;
}

/**
 * ADR 0080: the office queue — a conversation the management starts, a
 * request put under another topic, a request turned into a ticket (once,
 * also when two staff convert it at once), the inbox by unit, reply
 * templates, and a deferred suggestion.
 */
describe('The office queue — outreach, topics, conversion, reply templates, deferred', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let m: ReturnType<typeof managementHelpers>;
  let s: EngagementSetUp;
  let categoryId: string;
  let areaId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    m = managementHelpers(h);
    s = await e.setUp();
    ({ categoryId, areaId } = await e.inTx(s.c, async (tx) => {
      const category = await tx.ticketCategory.findFirstOrThrow({
        where: { key: 'plumbing' },
      });
      const id = newId();
      await tx.commonArea.create({
        data: {
          id,
          tenantId: s.c.tenantId,
          kind: 'area',
          code: `GD-${id.slice(-6)}`,
          nameAr: 'حديقة',
          nameEn: 'Garden',
        },
      });
      return { categoryId: category.id, areaId: id };
    }));
  }, 60_000);

  afterAll(() => h.close());

  const fieldsOf = (res: { body: unknown }) =>
    (res.body as { fields: unknown[] }).fields;
  const staffGet = async (id: string) =>
    (
      await e
        .http('get', `/management/requests/${id}`, s.manager.token)
        .expect(200)
    ).body as StaffRequest;
  const audits = (targetId: string, action: string) =>
    e.inTx(s.c, (tx) => tx.auditLog.findMany({ where: { targetId, action } }));

  describe('a conversation the management starts', () => {
    it('is the resident’s to read and answer, starts answered (no item of the queue), and tells them', async () => {
      const res = await e
        .http('post', '/management/outreach', s.manager.token, {
          residentAccountId: s.owner.id,
          topicId: await m.topicId(s.c),
          unitId: s.home.id,
          body: 'Your parcel locker code changed; please come by the office.',
        })
        .expect(201);
      const id = (res.body as { id: string }).id;
      expect(await staffGet(id)).toMatchObject({
        status: 'answered',
        outreach: true,
      });
      const mine = (
        await e
          .http('get', `/management-requests/${id}`, s.owner.token)
          .expect(200)
      ).body as { openedByManagement: boolean; outreach: boolean };
      expect(mine).toMatchObject({ openedByManagement: false, outreach: true });
      expect(
        (
          await e.notifications(s.c, s.owner.id, 'management_request.outreach')
        ).filter((n) => n.targetId === id),
      ).toHaveLength(1);
      const inbox = (
        await e
          .http('get', '/staff/inbox?type=management_request', s.manager.token)
          .expect(200)
      ).body as { data: { id: string }[] };
      expect(inbox.data.map((r) => r.id)).not.toContain(id);
      await e
        .http('post', `/management-requests/${id}/messages`, s.owner.token, {
          body: 'I will come tomorrow.',
        })
        .expect(201);
      expect((await staffGet(id)).status).toBe('in_progress');
      expect(
        await audits(id, 'management_request.outreach_started'),
      ).toHaveLength(1);
    });

    it('needs residents.read, and a resident account to write to', async () => {
      const handler = await e.handler(s.c);
      await e
        .http('post', '/management/outreach', handler.token, {
          residentAccountId: s.owner.id,
          topicId: await m.topicId(s.c),
          body: 'Hello',
        })
        .expect(403);
      const res = await e
        .http('post', '/management/outreach', s.manager.token, {
          residentAccountId: s.manager.id,
          topicId: await m.topicId(s.c),
          body: 'Hello',
        })
        .expect(400);
      expect(fieldsOf(res)).toEqual([
        { field: 'residentAccountId', code: 'AUTHOR_NOT_ELIGIBLE' },
      ]);
    });
  });

  describe('another topic', () => {
    it('moves a live request, its due time from the new target; the same topic is refused; audited by key', async () => {
      const { id } = await e.open(s.c, s.owner);
      const other = await e.inTx(s.c, (tx) =>
        tx.managementRequestTopic.findFirstOrThrow({
          where: {
            key: { notIn: ['general', 'release_request', 'partner_service'] },
            active: true,
          },
        }),
      );
      const same = await e
        .http('post', `/management/requests/${id}/topic`, s.manager.token, {
          topicId: await m.topicId(s.c),
        })
        .expect(400);
      expect(fieldsOf(same)).toEqual([
        { field: 'topicId', code: 'SAME_AS_CURRENT' },
      ]);
      await e
        .http('post', `/management/requests/${id}/topic`, s.manager.token, {
          topicId: other.id,
        })
        .expect(204);
      expect((await staffGet(id)).topic.key).toBe(other.key);
      const [entry] = await audits(id, 'management_request.reclassified');
      expect(entry.changes).toEqual({
        topicKey: { from: 'general', to: other.key },
      });
    });
  });

  describe('turned into a ticket', () => {
    it('opens the resident’s ticket in the unit, closes the request as converted for good, and tells them the number', async () => {
      const { id } = await e.open(s.c, s.owner, { unitId: s.home.id });
      const res = await e
        .http('post', `/management/requests/${id}/convert`, s.manager.token, {
          target: 'ticket',
          categoryId,
          description: 'The kitchen tap drips.',
        })
        .expect(201);
      const ticket = res.body as { id: string; number: string };
      expect(ticket.number).toMatch(/^MT-\d{6}$/);
      expect(await staffGet(id)).toMatchObject({
        status: 'closed',
        closeReason: 'converted',
        convertedTicket: { id: ticket.id, number: ticket.number },
      });
      const row = await e.inTx(s.c, (tx) =>
        tx.ticket.findUniqueOrThrow({ where: { id: ticket.id } }),
      );
      expect(row).toMatchObject({
        unitId: s.home.id,
        reporterId: s.owner.id,
      });
      const told = (
        await e.notifications(s.c, s.owner.id, 'management_request.converted')
      ).filter((n) => n.targetId === id);
      expect(told.map((n) => n.params)).toEqual([
        expect.objectContaining({ ticketNumber: ticket.number }),
      ]);
      const reopen = await e
        .http('post', `/management-requests/${id}/reopen`, s.owner.token, {
          body: 'Still dripping',
        })
        .expect(409);
      expect(reopen.body).toMatchObject({
        code: 'MANAGEMENT_REQUEST_CONVERTED',
        params: { ticketNumber: ticket.number },
      });
    });

    it('two converts at once: one ticket, the other refused', async () => {
      const { id } = await e.open(s.c, s.owner, { unitId: s.home.id });
      const convert = () =>
        e.http('post', `/management/requests/${id}/convert`, s.manager.token, {
          target: 'ticket',
          categoryId,
          description: 'The shower leaks.',
        });
      const [a, b] = await Promise.all([convert(), convert()]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const refused = a.status === 409 ? a : b;
      expect(refused.body).toMatchObject({
        code: 'MANAGEMENT_REQUEST_INVALID_TRANSITION',
        params: { status: 'closed' },
      });
      const tickets = await e.inTx(s.c, (tx) =>
        tx.ticket.count({
          where: { reporterId: s.owner.id, description: 'The shower leaks.' },
        }),
      );
      expect(tickets).toBe(1);
    });

    it('a fault outside the unit becomes the management’s work order on a common area', async () => {
      const { id } = await e.open(s.c, s.owner);
      const res = await e
        .http('post', `/management/requests/${id}/convert`, s.manager.token, {
          target: 'work_order',
          categoryId,
          commonAreaId: areaId,
          description: 'The garden sprinkler is broken.',
        })
        .expect(201);
      const row = await e.inTx(s.c, (tx) =>
        tx.ticket.findUniqueOrThrow({
          where: { id: (res.body as { id: string }).id },
        }),
      );
      expect(row).toMatchObject({ origin: 'staff', commonAreaId: areaId });
    });

    it('a ticket needs the request’s unit, and names no place of its own', async () => {
      const { id } = await e.open(s.c, s.owner);
      const res = await e
        .http('post', `/management/requests/${id}/convert`, s.manager.token, {
          target: 'ticket',
          categoryId,
          description: 'x',
        })
        .expect(400);
      expect(fieldsOf(res)).toEqual([
        { field: 'target', code: 'INVALID_VALUE' },
      ]);
      const placed = await e
        .http('post', `/management/requests/${id}/convert`, s.manager.token, {
          target: 'ticket',
          categoryId,
          commonAreaId: areaId,
          description: 'x',
        })
        .expect(400);
      expect(fieldsOf(placed)).toEqual([
        { field: 'commonAreaId', code: 'FIELD_NOT_ALLOWED' },
      ]);
    });

    it('needs tickets.dispatch beside requests.handle', async () => {
      const handler = await e.handler(s.c);
      const { id } = await e.open(s.c, s.owner, { unitId: s.home.id });
      await e
        .http('post', `/management/requests/${id}/convert`, handler.token, {
          target: 'ticket',
          categoryId,
          description: 'x',
        })
        .expect(403);
    });
  });

  it('the inbox lists one unit’s requests', async () => {
    const unit = await e.unit(s.c, 'B');
    const neighbour = await e.owner(s.c, unit.id);
    const { id } = await e.open(s.c, neighbour, { unitId: unit.id });
    const res = await e
      .http('get', `/management/requests?unitId=${unit.id}`, s.manager.token)
      .expect(200);
    expect(
      (res.body as { data: { id: string }[] }).data.map((r) => r.id),
    ).toEqual([id]);
  });

  it('reply templates: a topic’s own and those for any topic, read by handlers, written by requests.manage', async () => {
    const general = await m.topicId(s.c);
    const path = '/management/reply-templates';
    await e
      .http('post', path, s.manager.token, {
        name: `Any ${newId().slice(-6)}`,
        bodyEn: 'Thank you, we are on it.',
      })
      .expect(201);
    await e
      .http('post', path, s.manager.token, {
        name: `General ${newId().slice(-6)}`,
        topicId: general,
        bodyAr: 'شكرا لك.',
      })
      .expect(201);
    const none = await e
      .http('post', path, s.manager.token, { name: 'Empty' })
      .expect(400);
    expect(fieldsOf(none)).toEqual([
      { field: 'bodyEn', code: 'FIELD_REQUIRED' },
    ]);
    const handler = await e.handler(s.c);
    const list = (
      await e
        .http('get', `${path}?topicId=${general}`, handler.token)
        .expect(200)
    ).body as { data: { topicId: string | null }[] };
    expect(list.data.length).toBeGreaterThanOrEqual(2);
    expect(
      list.data.every((t) => t.topicId === null || t.topicId === general),
    ).toBe(true);
    await e
      .http('post', path, handler.token, { name: 'Mine', bodyEn: 'x' })
      .expect(403);
  });

  it('a suggestion deferred with its answer, then taken up later; never back to received', async () => {
    const id = await e.suggestion(s.c, s.owner);
    const bare = await e.move(s.manager, id, 'deferred').expect(400);
    expect(fieldsOf(bare)).toEqual([
      { field: 'response', code: 'FIELD_REQUIRED' },
    ]);
    await e
      .move(s.manager, id, 'deferred', 'Next year, with the pool works.')
      .expect(204);
    await e.move(s.manager, id, 'received', 'x').expect(409);
    await e.move(s.manager, id, 'planned', 'Planned for March.').expect(204);
  });
});
