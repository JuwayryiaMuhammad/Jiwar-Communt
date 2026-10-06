import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };

const STATUSES = [
  'new',
  'assigned',
  'in_progress',
  'on_hold',
  'completed',
  'closed',
  'cancelled',
] as const;
type Status = (typeof STATUSES)[number];

const MINUTE = 60_000;

/**
 * ADR 0032: who cancels a ticket, and when. The reporter (or creator)
 * while it is `new` or `assigned`, and only while they still have
 * `tickets` on its unit; a dispatcher any time before it is closed. The
 * unit's primary who is not a party gets 403; anyone who does not see the
 * ticket gets 404. The reason code is checked first. A cancel tells the
 * technician and ends an active visit (ADR 0034).
 */
describe('Maintenance — cancel rules', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  /** A residing co-owner: reports tickets the primary is no party to. */
  let coOwner: Who;
  /** A landlord of the unit and a resident of another one: they see nothing. */
  let landlord: Who;
  let neighbour: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    coOwner = await d.who(
      s.c,
      (await d.x.resident(s.c, [s.unit.id])).id,
      'resident',
    );
    const l = await d.x.asManager(s.c, () =>
      d.x.residents.createResident({
        ...d.x.person('landlord'),
        units: [{ unitId: s.unit.id, occupancyType: 'owner', resides: false }],
      }),
    );
    landlord = await d.who(s.c, l.id, 'resident');
    neighbour = await d.who(
      s.c,
      (await d.x.resident(s.c, [(await d.x.unit(s.c)).id])).id,
      'resident',
    );
  }, 90_000);

  afterAll(() => h.close());

  // --- helpers ---------------------------------------------------------------

  const tech = () => s.techs[0];

  /** A ticket `reporter` opens, driven to `status` over HTTP. */
  async function inStatus(status: Status, reporter: Who): Promise<string> {
    const opened = await d
      .http('post', '/tickets', reporter.token, {
        unitId: s.unit.id,
        categoryId: await d.categoryId(s.c, 'general'),
        description: 'Cancel fixture',
      })
      .expect(201);
    const id = (opened.body as { id: string }).id;
    const step = (path: string, token: string, body?: object) =>
      d.http('post', path, token, body).expect(204);
    if (status === 'new') return id;
    if (status === 'cancelled') {
      await step(`/maintenance/tickets/${id}/cancel`, s.supervisor.token, {
        reasonCode: 'invalid',
      });
      return id;
    }
    await step(`/maintenance/tickets/${id}/assign`, s.supervisor.token, {
      technicianId: tech().id,
    });
    if (status === 'assigned') return id;
    await step(`/technician/tickets/${id}/start`, tech().token);
    if (status === 'in_progress') return id;
    if (status === 'on_hold') {
      await step(`/technician/tickets/${id}/hold`, tech().token, {
        holdReason: 'awaiting_parts',
      });
      return id;
    }
    await step(`/technician/tickets/${id}/complete`, tech().token);
    if (status === 'completed') return id;
    await step(`/tickets/${id}/confirm`, reporter.token, { rating: 5 });
    return id;
  }

  const cancel = (who: Who, id: string, reasonCode?: string) =>
    d.http(
      'post',
      `/tickets/${id}/cancel`,
      who.token,
      reasonCode ? { reasonCode } : {},
    );
  const cancelByDispatch = (id: string, reasonCode?: string) =>
    d.http(
      'post',
      `/maintenance/tickets/${id}/cancel`,
      s.supervisor.token,
      reasonCode ? { reasonCode } : {},
    );

  const outcome = (res: { status: number; body: unknown }) =>
    res.status === 204
      ? 204
      : `${res.status} ${(res.body as { code: string }).code}`;

  const notices = (ticketId: string, kind: string) =>
    d.inTenant(s.c, async (tx) =>
      (
        await tx.notification.findMany({ where: { targetId: ticketId, kind } })
      ).map((n) => ({ to: n.accountId, params: n.params })),
    );

  // --- the matrix --------------------------------------------------------------

  const invalid = '409 TICKET_INVALID_TRANSITION';

  it('the reporter: while new or assigned', async () => {
    const got: Record<string, unknown> = {};
    for (const status of STATUSES)
      got[status] = outcome(
        await cancel(
          s.owner,
          await inStatus(status, s.owner),
          'reporter_request',
        ),
      );
    expect(got).toEqual({
      new: 204,
      assigned: 204,
      in_progress: invalid,
      on_hold: invalid,
      completed: invalid,
      closed: invalid,
      cancelled: invalid,
    });
  });

  it('a dispatcher: any time before it is closed', async () => {
    const got: Record<string, unknown> = {};
    for (const status of STATUSES)
      got[status] = outcome(
        await cancelByDispatch(await inStatus(status, s.owner), 'invalid'),
      );
    expect(got).toEqual({
      new: 204,
      assigned: 204,
      in_progress: 204,
      on_hold: 204,
      completed: 204,
      closed: invalid,
      cancelled: invalid,
    });
  });

  it('a reporter who lost `tickets`: 403 TICKETS_NOT_ALLOWED, whatever the status', async () => {
    const joined = await d.x.joinFamily(s.c, s.unit.id, s.owner);
    const member: Who = {
      id: joined.id,
      token: await h.tokenFor({
        sub: joined.id,
        tid: s.c.tenantId,
        typ: 'family',
      }),
    };
    const ids: Record<string, string> = {};
    for (const status of STATUSES) ids[status] = await inStatus(status, member);
    await d
      .http(
        'post',
        `/household/members/${joined.memberId}/permissions/revoke`,
        s.owner.token,
        {
          permission: 'tickets',
          reasonCode: 'no_longer_needed',
          reason: 'Not any more',
        },
      )
      .expect(204);
    for (const status of STATUSES)
      expect([
        status,
        outcome(await cancel(member, ids[status], 'reporter_request')),
      ]).toEqual([status, '403 TICKETS_NOT_ALLOWED']);
  });

  it('the primary who is no party: 403; a landlord or another unit’s resident: 404', async () => {
    for (const status of STATUSES) {
      const id = await inStatus(status, coOwner);
      expect([
        status,
        outcome(await cancel(s.owner, id, 'duplicate')),
        outcome(await cancel(landlord, id, 'duplicate')),
        outcome(await cancel(neighbour, id, 'duplicate')),
      ]).toEqual([
        status,
        '403 TICKET_ACTION_NOT_ALLOWED',
        '404 TICKET_NOT_FOUND',
        '404 TICKET_NOT_FOUND',
      ]);
    }
  });

  // --- the reason ----------------------------------------------------------------

  it('a reason code from the closed list, on both routes, checked before visibility', async () => {
    const id = await inStatus('new', s.owner);
    for (const res of [await cancel(s.owner, id), await cancelByDispatch(id)])
      expect(res.body).toMatchObject({
        code: 'REASON_REQUIRED',
        fields: [{ field: 'reasonCode', code: 'FIELD_REQUIRED' }],
      });
    for (const res of [
      await cancel(s.owner, id, 'no_such_code'),
      await cancelByDispatch(id, 'no_such_code'),
    ]) {
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: [{ field: 'reasonCode', code: 'INVALID_REASON_CODE' }],
      });
    }
    // Someone who does not see the ticket learns nothing from the order:
    // the same 400 as for any ticket id.
    expect(outcome(await cancel(neighbour, id))).toBe('400 REASON_REQUIRED');
    expect((await d.ticketRow(s.c, id)).status).toBe('new');
  });

  // --- who is told -----------------------------------------------------------------

  it('the reporter cancels an assigned ticket: the technician is told, and the active visit ends', async () => {
    const id = await inStatus('assigned', s.owner);
    const start = Date.now() + 24 * 60 * MINUTE;
    const proposed = await d
      .http('post', `/technician/tickets/${id}/visits`, tech().token, {
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 60 * MINUTE).toISOString(),
      })
      .expect(201);
    const visitId = (proposed.body as { id: string }).id;
    await cancel(s.owner, id, 'reporter_request').expect(204);

    expect(await notices(id, 'ticket.status_changed')).toContainEqual({
      to: tech().id,
      params: expect.objectContaining({ status: 'cancelled' }) as unknown,
    });
    const visit = await d.inTenant(s.c, (tx) =>
      tx.ticketVisit.findUniqueOrThrow({ where: { id: visitId } }),
    );
    expect(visit).toMatchObject({
      status: 'cancelled',
      cancelReasonCode: 'ticket_cancelled',
      cancelledBySide: 'system',
    });
  });

  it('a dispatcher cancels: the reporter and the technician are told', async () => {
    const id = await inStatus('assigned', s.owner);
    await cancelByDispatch(id, 'invalid').expect(204);
    const told = (await notices(id, 'ticket.status_changed')).map((n) => n.to);
    expect(told).toEqual(expect.arrayContaining([s.owner.id, tech().id]));
  });
});
