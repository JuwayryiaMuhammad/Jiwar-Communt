import { officeStatus } from '../../src/management/settings/office-hours-rules';
import { dbClock } from '../setup/compound-clock';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { managementHelpers, type Who } from '../setup/management';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

/**
 * Talking to the management (ADR 0058, on ADR 0039): who owns a topic (a
 * role, never a person) and gets its unassigned requests; when the office
 * is open; and a request to release something held, about what the author
 * sees and with the hold's reason.
 */
describe('Management — owners, office hours and release requests', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let m: ReturnType<typeof managementHelpers>;
  let s: SetUp;
  let handler: Who;
  let manager: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    m = managementHelpers(h);
    s = await d.setUp(1);
    handler = await m.handler(s.c);
    manager = await m.who(s.c, s.c.managerId, 'manager');
  }, 120_000);

  afterAll(() => h.close());

  const code = (r: { body: unknown }) => (r.body as { code: string }).code;
  const fields = (r: { body: unknown }) =>
    (r.body as { fields: { field: string; code: string }[] }).fields;
  const roleId = (key: string) =>
    d.inTenant(
      s.c,
      async (tx) =>
        (
          await tx.role.findUniqueOrThrow({
            where: { tenantId_key: { tenantId: s.c.tenantId, key } },
          })
        ).id,
    );
  const setOwner = async (
    topicKey: string,
    ownerRoleId: string | null,
    status: number,
  ) =>
    m
      .http(
        'patch',
        `/management/request-topics/${await m.topicId(s.c, topicKey)}`,
        manager.token,
        { ownerRoleId },
      )
      .expect(status);
  const toldOf = (requestId: string) =>
    d.inTenant(s.c, async (tx) =>
      (
        await tx.notification.findMany({
          where: { targetId: requestId, kind: 'management_request.created' },
        })
      )
        .map((n) => n.accountId)
        .sort(),
    );

  describe('a topic’s owner', () => {
    it('residents see the role; an unassigned request goes to its handlers', async () => {
      await setOwner(
        'billing_fees',
        await roleId('maintenance_supervisor'),
        200,
      );
      const options = (
        (
          await m
            .http('get', '/management-request-topics', s.owner.token)
            .expect(200)
        ).body as {
          data: { key: string; owner: { roleKey: string } | null }[];
        }
      ).data;
      expect(
        options.find((t) => t.key === 'billing_fees')?.owner,
      ).toMatchObject({
        roleKey: 'maintenance_supervisor',
      });
      expect(options.find((t) => t.key === 'general')?.owner).toBeNull();
      expect(JSON.stringify(options)).not.toContain(handler.id);

      const billing = await m.open(s.c, s.owner, {
        topicId: await m.topicId(s.c, 'billing_fees'),
      });
      // The role's handlers: the supervisors (the set-up's one gained it too).
      expect(await toldOf(billing.id)).toEqual(
        [handler.id, s.supervisor.id].sort(),
      );
      const general = await m.open(s.c, s.owner);
      expect(await toldOf(general.id)).toEqual(
        [handler.id, s.supervisor.id, manager.id].sort(),
      );
    });

    it('an owner role with no handler leaves the request to every handler', async () => {
      await setOwner('facilities', await roleId('technician'), 200);
      const r = await m.open(s.c, s.owner, {
        topicId: await m.topicId(s.c, 'facilities'),
      });
      expect(await toldOf(r.id)).toEqual(
        [handler.id, s.supervisor.id, manager.id].sort(),
      );
    });

    it('the owner is a staff role of the compound', async () => {
      const resident = await setOwner(
        'documents',
        await roleId('resident'),
        400,
      );
      expect(fields(resident)).toEqual([
        { field: 'ownerRoleId', code: 'TOPIC_OWNER_NOT_STAFF' },
      ]);
      const unknown = await setOwner(
        'documents',
        '0192a5f0-1c2b-7d3e-8f40-0000000058d1',
        404,
      );
      expect(code(unknown)).toBe('ROLE_NOT_FOUND');
      await setOwner('documents', null, 200);
    });
  });

  describe('the office hours', () => {
    it('residents read the windows, the time zone and whether it is open now', async () => {
      const before = dbClock();
      const res = await m
        .http('get', '/management-office-hours', s.owner.token)
        .expect(200);
      const after = dbClock();
      const body = res.body as {
        windows: { weekday: number; startMinute: number; endMinute: number }[];
        timeZone: string;
        openNow: boolean;
        closesAt: string | null;
        nextOpensAt: string | null;
      };
      expect(res.headers['cache-control']).toBe('no-store');
      expect(body.windows).toHaveLength(6);
      expect(body.timeZone).toBe('Africa/Cairo');
      const a = officeStatus(body.windows, before, body.timeZone);
      const b = officeStatus(body.windows, after, body.timeZone);
      // Unless a window opened or closed in between, it is that answer.
      if (a.openNow === b.openNow)
        expect({
          openNow: body.openNow,
          closesAt: body.closesAt,
          nextOpensAt: body.nextOpensAt,
        }).toEqual({
          openNow: a.openNow,
          closesAt: a.closesAt?.toISOString() ?? null,
          nextOpensAt: a.nextOpensAt?.toISOString() ?? null,
        });
      await m
        .http('get', '/management-office-hours', s.supervisor.token)
        .expect(403);
    });
  });

  describe('a request to release a hold', () => {
    async function onHold(): Promise<string> {
      const id = await d.openTicket(s);
      await d
        // The supervisors' role handles requests only, here: the manager.
        .http('post', `/maintenance/tickets/${id}/assign`, manager.token, {
          technicianId: s.techs[0].id,
        })
        .expect(204);
      await d
        .http('post', `/technician/tickets/${id}/start`, s.techs[0].token)
        .expect(204);
      await d
        .http('post', `/technician/tickets/${id}/hold`, s.techs[0].token, {
          holdReason: 'awaiting_parts',
        })
        .expect(204);
      return id;
    }
    const release = async (
      about: { type: string; id: string } | undefined,
      status: number,
      topicKey = 'release_request',
      who: Who = s.owner,
    ) =>
      m
        .http('post', '/management-requests', who.token, {
          type: 'general',
          topicId: await m.topicId(s.c, topicKey),
          body: 'Please release it.',
          ...(about ? { about } : {}),
        })
        .expect(status);

    it('about a ticket on hold: its reason kept; one live request per held item', async () => {
      const ticket = await onHold();
      const created = await release({ type: 'maintenance', id: ticket }, 201);
      const id = (created.body as { id: string }).id;
      const read = (
        await m
          .http('get', `/management-requests/${id}`, s.owner.token)
          .expect(200)
      ).body as { about: unknown };
      expect(read.about).toEqual({
        type: 'maintenance',
        id: ticket,
        reasonCode: 'awaiting_parts',
      });
      const twin = await release({ type: 'maintenance', id: ticket }, 409);
      expect(code(twin)).toBe('DUPLICATE_RESOURCE');
      // Closed, it leaves room for another.
      await m
        .http('post', `/management-requests/${id}/withdraw`, s.owner.token)
        .expect(204);
      await release({ type: 'maintenance', id: ticket }, 201);
    });

    it('something not held, not the author’s to see, or with the wrong topic is refused', async () => {
      const running = await d.openTicket(s);
      expect(
        code(await release({ type: 'maintenance', id: running }, 404)),
      ).toBe('HELD_ITEM_NOT_FOUND');
      const held = await onHold();
      const elsewhere = await d.x.unit(s.c);
      const neighbour = await m.who(
        s.c,
        (await d.x.resident(s.c, [elsewhere.id])).id,
        'resident',
      );
      expect(
        code(
          await release(
            { type: 'maintenance', id: held },
            404,
            'release_request',
            neighbour,
          ),
        ),
      ).toBe('HELD_ITEM_NOT_FOUND');
      // The unit has no credit; a permit that is not stopped is not held.
      for (const type of ['unit_credit', 'unit_permit'])
        expect(code(await release({ type, id: s.unit.id }, 404))).toBe(
          'HELD_ITEM_NOT_FOUND',
        );
      expect(
        fields(
          await release({ type: 'maintenance', id: held }, 400, 'general'),
        ),
      ).toEqual([{ field: 'topicId', code: 'RELEASE_TOPIC_REQUIRED' }]);
      expect(fields(await release(undefined, 400))).toEqual([
        { field: 'about', code: 'FIELD_REQUIRED' },
      ]);
    });

    it('two at once for the same hold: one is opened (×3)', async () => {
      const releaseTopic = await m.topicId(s.c, 'release_request');
      for (let i = 0; i < 3; i++) {
        const ticket = await onHold();
        const statuses = await Promise.all(
          [0, 1].map(() =>
            m
              .http('post', '/management-requests', s.owner.token, {
                type: 'general',
                topicId: releaseTopic,
                body: 'Please release it.',
                about: { type: 'maintenance', id: ticket },
              })
              .then((r) => r.status),
          ),
        );
        expect(statuses.sort()).toEqual([201, 409]);
      }
    });

    it('what a request is about never changes (the database)', async () => {
      const ticket = await onHold();
      const id = (
        (await release({ type: 'maintenance', id: ticket }, 201)).body as {
          id: string;
        }
      ).id;
      await expect(
        d.inTenant(s.c, (tx) =>
          tx.managementRequest.update({
            where: { id },
            data: { aboutReason: 'other' },
          }),
        ),
      ).rejects.toThrow(/never changes/);
    });
  });
});
