import { ResidentsService } from '../../src/community';
import { RolesService } from '../../src/core/access/roles.service';
import { dispatchHelpers } from '../setup/dispatch';
import { fileHelpers } from '../setup/files';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { managementHelpers, type Who } from '../setup/management';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

/**
 * ADR 0039: "all my requests" — the caller's management requests and the
 * maintenance tickets they can see, as one list by last activity. A
 * ticket's activity is kept by triggers (status or cycle change,
 * non-internal message, photo); the tickets shown are exactly the ones
 * `GET /tickets` shows.
 */
describe('All my requests', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let m: ReturnType<typeof managementHelpers>;
  let s: SetUp;
  let family: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    m = managementHelpers(h);
    s = await d.setUp(1);
    const member = await d.x.joinFamily(s.c, s.unit.id, s.owner);
    family = await m.who(s.c, member.id, 'family');
  }, 120_000);

  afterAll(() => h.close());

  type Item = {
    type: string;
    id: string;
    number: string;
    status: string;
    lastActivityAt: string;
    categoryKey: string | null;
    topicKey: string | null;
    requestType: string | null;
    unitId: string | null;
  };
  const feed = async (who: Who, query = 'limit=100') =>
    (await m.http('get', `/me/requests?${query}`, who.token).expect(200))
      .body as { data: Item[]; nextCursor: string | null };
  const ticketRow = (id: string) =>
    d.inTenant(s.c, (tx) => tx.ticket.findUniqueOrThrow({ where: { id } }));
  const openTicket = async (who: Who, unitId = s.unit.id) =>
    (
      (
        await d
          .http('post', '/tickets', who.token, {
            unitId,
            categoryId: await d.categoryId(s.c, 'plumbing'),
            description: 'A leak',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  const assign = (id: string) =>
    d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: s.techs[0].id,
      })
      .expect(204);
  /** The order both sources promise: time, then id, newest first. */
  const ordered = (items: Item[]) =>
    [...items].sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime() -
          new Date(a.lastActivityAt).getTime() || (a.id < b.id ? 1 : -1),
    );

  describe('a ticket’s last activity', () => {
    it('starts at its creation, and moves with a status change', async () => {
      const id = await openTicket(s.owner);
      const created = await ticketRow(id);
      expect(created.lastActivityAt).toEqual(created.createdAt);
      await assign(id);
      const assigned = await ticketRow(id);
      expect(assigned.status).toBe('assigned');
      expect(assigned.lastActivityAt.getTime()).toBeGreaterThan(
        created.lastActivityAt.getTime(),
      );
    });

    it('moves to a message’s own time; a staff note moves nothing', async () => {
      const id = await openTicket(s.owner);
      await assign(id);
      const before = await ticketRow(id);
      const note = await d
        .http(
          'post',
          `/maintenance/tickets/${id}/messages`,
          s.supervisor.token,
          {
            body: 'Internal only',
            internal: true,
          },
        )
        .expect(201);
      expect((await ticketRow(id)).lastActivityAt).toEqual(
        before.lastActivityAt,
      );
      const posted = await d
        .http('post', `/tickets/${id}/messages`, s.owner.token, {
          body: 'Still leaking',
        })
        .expect(201);
      const after = await ticketRow(id);
      expect(after.lastActivityAt.toISOString()).toBe(
        (posted.body as { createdAt: string }).createdAt,
      );
      expect(after.lastActivityAt.getTime()).toBeGreaterThanOrEqual(
        new Date((note.body as { createdAt: string }).createdAt).getTime(),
      );
    });

    it('moves with a photo', async () => {
      const id = await openTicket(s.owner);
      const before = await ticketRow(id);
      await d
        .http('post', `/tickets/${id}/photos`, s.owner.token, {
          fileId: await fileHelpers(h).ready(s.owner.token, 'ticket_photo'),
        })
        .expect(201);
      const attachment = await d.inTenant(s.c, (tx) =>
        tx.ticketAttachment.findFirstOrThrow({ where: { ticketId: id } }),
      );
      const after = await ticketRow(id);
      expect(after.lastActivityAt).toEqual(attachment.createdAt);
      expect(after.lastActivityAt.getTime()).toBeGreaterThanOrEqual(
        before.lastActivityAt.getTime(),
      );
    });

    it('never moves back: an older time written by hand is ignored by the triggers', async () => {
      const id = await openTicket(s.owner);
      const before = await ticketRow(id);
      await d.inTenant(
        s.c,
        (tx) =>
          tx.$executeRaw`
          INSERT INTO ticket_messages (id, tenant_id, ticket_id, sender_account_id, body, created_at)
          VALUES (gen_random_uuid(), ${s.c.tenantId}::uuid, ${id}::uuid,
                  ${s.owner.id}::uuid, 'Back-dated', ${new Date(before.createdAt.getTime() - 3_600_000)})`,
      );
      expect((await ticketRow(id)).lastActivityAt).toEqual(
        before.lastActivityAt,
      );
    });
  });

  describe('the list', () => {
    it('merges both kinds, newest activity first, each marked and named', async () => {
      const ticket = await openTicket(s.owner);
      const request = await m.open(s.c, s.owner, { unitId: s.unit.id });
      const { data } = await feed(s.owner);
      expect(data.map((x) => x.id)).toEqual(ordered(data).map((x) => x.id));
      expect(data.find((x) => x.id === ticket)).toEqual({
        type: 'maintenance',
        id: ticket,
        number: expect.stringMatching(/^MT-\d{6}$/) as string,
        status: 'new',
        lastActivityAt: expect.any(String) as string,
        categoryKey: 'plumbing',
        topicKey: null,
        requestType: null,
        unitId: s.unit.id,
        kind: null,
        appeal: null,
      });
      expect(data.find((x) => x.id === request.id)).toEqual({
        type: 'management',
        id: request.id,
        number: request.number,
        status: 'open',
        lastActivityAt: expect.any(String) as string,
        categoryKey: null,
        topicKey: 'general',
        requestType: 'question',
        unitId: s.unit.id,
        kind: null,
        appeal: null,
      });
      // The newest thing is first.
      expect(data[0].id).toBe(request.id);
    });

    it('activity moves an item to the top: a reply on a request, a message on a ticket; a note on either moves nothing', async () => {
      const ticket = await openTicket(s.owner);
      const request = await m.open(s.c, s.owner);
      const manager = await m.who(s.c, s.c.managerId, 'manager');
      expect((await feed(s.owner)).data[0].id).toBe(request.id);

      await d
        .http('post', `/tickets/${ticket}/messages`, s.owner.token, {
          body: 'Any news?',
        })
        .expect(201);
      expect((await feed(s.owner)).data[0].id).toBe(ticket);

      await m
        .http(
          'post',
          `/management/requests/${request.id}/messages`,
          manager.token,
          {
            body: 'For staff eyes',
            internal: true,
          },
        )
        .expect(201);
      await d
        .http(
          'post',
          `/maintenance/tickets/${ticket}/messages`,
          s.supervisor.token,
          {
            body: 'For staff eyes',
            internal: true,
          },
        )
        .expect(201);
      expect((await feed(s.owner)).data[0].id).toBe(ticket);

      await m
        .http(
          'post',
          `/management/requests/${request.id}/messages`,
          manager.token,
          {
            body: 'We are on it',
          },
        )
        .expect(201);
      const top = (await feed(s.owner)).data[0];
      expect(top).toMatchObject({ id: request.id, status: 'in_progress' });
    });

    it('pages by keyset across both kinds without a gap or a repeat', async () => {
      for (let i = 0; i < 3; i++) {
        await openTicket(s.owner);
        await m.open(s.c, s.owner);
      }
      const all = (await feed(s.owner)).data;
      expect(new Set(all.map((x) => x.type))).toEqual(
        new Set(['maintenance', 'management']),
      );
      for (const size of [1, 2, 5]) {
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const page = await feed(
            s.owner,
            `limit=${size}${cursor ? `&cursor=${cursor}` : ''}`,
          );
          expect(page.data.length).toBeLessThanOrEqual(size);
          seen.push(...page.data.map((x) => x.id));
          cursor = page.nextCursor;
        } while (cursor);
        expect(seen).toEqual(all.map((x) => x.id));
      }
      const bad = await m
        .http('get', '/me/requests?cursor=nonsense', s.owner.token)
        .expect(400);
      expect(bad.body).toMatchObject({
        fields: [{ field: 'cursor', code: 'INVALID_FORMAT' }],
      });
    });

    it('answers no-store, and is the residents’ alone', async () => {
      const res = await m
        .http('get', '/me/requests', s.owner.token)
        .expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      await m.http('get', '/me/requests', s.supervisor.token).expect(403);
      await m
        .http(
          'get',
          '/me/requests',
          (await m.who(s.c, s.c.managerId, 'manager')).token,
        )
        .expect(403);
    });
  });

  describe('what each reader sees', () => {
    const ticketIds = async (who: Who) =>
      (
        (await d.http('get', '/tickets?limit=100', who.token).expect(200))
          .body as { data: { id: string }[] }
      ).data
        .map((t) => t.id)
        .sort();
    const feedIds = async (who: Who, type: Item['type']) =>
      (await feed(who)).data
        .filter((x) => x.type === type)
        .map((x) => x.id)
        .sort();

    it('the tickets are exactly the ones GET /tickets lists: the primary sees the unit’s, a member their own', async () => {
      const byFamily = await openTicket(family);
      const byOwner = await openTicket(s.owner);
      for (const who of [s.owner, family])
        expect(await feedIds(who, 'maintenance')).toEqual(await ticketIds(who));
      // The primary sees the member's ticket; the member not the primary's.
      expect(await feedIds(s.owner, 'maintenance')).toContain(byFamily);
      expect(await feedIds(family, 'maintenance')).not.toContain(byOwner);
    });

    it('the management requests are the caller’s own: never the household’s', async () => {
      const mine = await m.open(s.c, family, { unitId: s.unit.id });
      const theirs = await m.open(s.c, s.owner, { unitId: s.unit.id });
      expect(await feedIds(family, 'management')).toContain(mine.id);
      expect(await feedIds(family, 'management')).not.toContain(theirs.id);
      expect(await feedIds(s.owner, 'management')).not.toContain(mine.id);
    });

    it('another compound’s resident sees nothing of this one', async () => {
      const other = await m.setUp();
      expect((await feed(other.owner)).data).toEqual([]);
    });

    it('a role without tickets.create gets the requests alone, and the other way round', async () => {
      const c = await d.setUp(0);
      const who = await m.who(c.c, c.owner.id, 'resident');
      const ticket = (
        (
          await d
            .http('post', '/tickets', who.token, {
              unitId: c.unit.id,
              categoryId: await d.categoryId(c.c, 'general'),
              description: 'Before the role changed',
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      const request = await m.open(c.c, who);
      const setRole = (permissions: string[]) =>
        d.x.asManager(c.c, async () => {
          const role = await d.x.prisma.tenant.role.findUniqueOrThrow({
            where: {
              tenantId_key: { tenantId: c.c.tenantId, key: 'resident' },
            },
          });
          await h.moduleRef
            .get(RolesService)
            .replacePermissions(role.id, permissions);
        });
      await setRole(['units.read', 'requests.create']);
      expect((await feed(who)).data.map((x) => x.id)).toEqual([request.id]);
      await setRole(['units.read', 'tickets.create']);
      expect((await feed(who)).data.map((x) => x.id)).toEqual([ticket]);
      // Neither: nothing of either (ADR 0058: the list is every resident's,
      // each source deciding what it shows).
      await setRole(['units.read']);
      expect((await feed(who)).data).toEqual([]);
    });
  });

  describe('someone who left the unit', () => {
    it('keeps their ticket in the list, ordered and dated by its last status change: what the household writes afterwards neither moves it nor shows a time', async () => {
      const leaver = await m.who(
        s.c,
        (await d.x.resident(s.c, [s.unit.id])).id,
        'resident',
      );
      const id = await openTicket(leaver);
      await assign(id);
      /** When the ticket last changed status: its history says. */
      const lastStatusAt = async () =>
        (
          await d.inTenant(s.c, (tx) =>
            tx.ticketStatusHistory.findFirstOrThrow({
              where: { ticketId: id },
              orderBy: { createdAt: 'desc' },
            }),
          )
        ).createdAt;
      const statusAt = await lastStatusAt();
      const request = await m.open(s.c, leaver);
      const before = (await feed(leaver)).data;
      expect(before.map((x) => x.id)).toEqual([request.id, id]);

      const occupancy = (await d.x.occupancies(s.c, s.unit.id)).find(
        (o) => o.accountId === leaver.id && o.status === 'active',
      )!;
      await d.x.asManager(s.c, () =>
        h.moduleRef
          .get(ResidentsService)
          .endOccupancy(occupancy.id, { code: 'moved_out', text: 'Left' }),
      );
      // The household goes on writing on the ticket.
      await d
        .http('post', `/tickets/${id}/messages`, s.owner.token, {
          body: 'After they left',
        })
        .expect(201);
      expect((await ticketRow(id)).lastActivityAt.getTime()).toBeGreaterThan(
        statusAt.getTime(),
      );

      const after = (await feed(leaver)).data;
      const item = after.find((x) => x.id === id)!;
      // Still listed, as GET /tickets lists it…
      expect(item).toMatchObject({ type: 'maintenance', status: 'assigned' });
      // …at the time of its last status change, below their newer request.
      expect(item.lastActivityAt).toBe(statusAt.toISOString());
      expect(after.map((x) => x.id)).toEqual([request.id, id]);
      // The primary, who still lives there, sees the new activity on top.
      const owners = (await feed(s.owner)).data;
      expect(owners[0].id).toBe(id);
      expect(new Date(owners[0].lastActivityAt).getTime()).toBeGreaterThan(
        statusAt.getTime(),
      );

      // A status change is theirs to see: it moves the ticket for them too.
      await d
        .http('post', `/technician/tickets/${id}/start`, s.techs[0].token)
        .expect(204);
      const moved = (await feed(leaver)).data;
      expect(moved[0]).toMatchObject({
        id,
        status: 'in_progress',
        lastActivityAt: (await lastStatusAt()).toISOString(),
      });
      // And paging still walks their whole list once.
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await feed(
          leaver,
          `limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        );
        seen.push(...page.data.map((x) => x.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(moved.map((x) => x.id));
    });
  });
});
