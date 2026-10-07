import { Client } from 'pg';
import { ResidentsService } from '../../src/community/residents/residents.service';
import { SlaSweep } from '../../src/maintenance/sla/sla-sweep';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { slaClocks, slaEvents } from '../setup/sla';
import { required } from '../setup/test-env';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };
type Slot = { startsAt: string; endsAt: string };

const MINUTE = 60_000;

/**
 * ADR 0038: a resident books a check-up. It is a ticket of kind
 * `preventive` with the window they asked for; when a technician takes it,
 * the window is proposed to them from the residents' side, while the
 * request still stands. The SLA does not measure it.
 */
describe('Maintenance — preventive requests', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  let slots: Slot[];
  let next = 0;
  let plumbingCheck: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(2);
    // The slots of the days after tomorrow: far enough to stay bookable.
    const from = new Date(Date.now() + 2 * 24 * 60 * MINUTE)
      .toISOString()
      .slice(0, 10);
    const res = await d
      .http(
        'get',
        `/preventive-slots?unitId=${s.unit.id}&from=${from}&days=3`,
        s.owner.token,
      )
      .expect(200);
    slots = (res.body as { data: Slot[] }).data;
    plumbingCheck = await serviceId('plumbing_check');
  }, 90_000);

  afterAll(() => h.close());

  // --- helpers ---------------------------------------------------------------

  /** A slot nobody used yet in this suite. */
  const slot = () => slots[next++];

  const serviceId = async (key: string, c = s.c) =>
    d.inTenant(
      c,
      async (tx) =>
        (await tx.preventiveService.findFirstOrThrow({ where: { key } })).id,
    );

  /** Not awaited here: a supertest request is itself awaited once. */
  const request = (body: object = {}, who: Who = s.owner, key?: string) => {
    const req = d.http('post', '/tickets/preventive', who.token, {
      unitId: s.unit.id,
      serviceId: plumbingCheck,
      ...slot(),
      ...body,
    });
    return key ? req.set('Idempotency-Key', key) : req;
  };

  const requested = async (body: object = {}, who: Who = s.owner) =>
    ((await request(body, who).expect(201)).body as { id: string }).id;

  const assign = (id: string, tech: Who = s.techs[0]) =>
    d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: tech.id,
      })
      .expect(204);

  const reassign = (id: string, tech: Who) =>
    d
      .http('post', `/maintenance/tickets/${id}/reassign`, s.supervisor.token, {
        technicianId: tech.id,
        reasonCode: 'workload',
      })
      .expect(204);

  const visits = (id: string) =>
    d.inTenant(s.c, (tx) =>
      tx.ticketVisit.findMany({
        where: { ticketId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );

  const events = (id: string) =>
    d.inTenant(s.c, async (tx) =>
      (
        await tx.ticketVisitEvent.findMany({
          where: { ticketId: id },
          orderBy: [{ at: 'asc' }, { id: 'asc' }],
        })
      ).map((e) => [e.kind, e.actorSide, e.actorId, e.reasonCode]),
    );

  const notes = (id: string, kind: string) =>
    d.inTenant(s.c, (tx) =>
      tx.notification.findMany({ where: { targetId: id, kind } }),
    );

  // --- booking ---------------------------------------------------------------

  it('the booking slots are the compound’s visiting hours, from 15 minutes ahead', async () => {
    expect(slots.length).toBeGreaterThan(0);
    for (const x of slots)
      expect(
        new Date(x.endsAt).getTime() - new Date(x.startsAt).getTime(),
      ).toBe(60 * MINUTE);
    // Ten slots a day (08:00–18:00, hourly), three days.
    expect(slots).toHaveLength(30);
    const today = await d
      .http(
        'get',
        `/preventive-slots?unitId=${s.unit.id}&days=1`,
        s.owner.token,
      )
      .expect(200);
    for (const x of (today.body as { data: Slot[] }).data)
      expect(new Date(x.startsAt).getTime()).toBeGreaterThanOrEqual(
        Date.now() + 14 * MINUTE,
      );
    // Another compound's unit is not found; nothing is said of it.
    const other = await d.setUp(0);
    const foreign = await d
      .http('get', `/preventive-slots?unitId=${other.unit.id}`, s.owner.token)
      .expect(404);
    expect((foreign.body as { code: string }).code).toBe('UNIT_NOT_FOUND');
  });

  it('a request is a preventive ticket under the service’s category, with the window asked for; every view shows it, and an absent note is an empty description', async () => {
    const window = slots[next];
    const id = await requested();
    expect(await d.ticketRow(s.c, id)).toMatchObject({
      kind: 'preventive',
      preventiveServiceId: plumbingCheck,
      categoryId: await d.categoryId(s.c, 'plumbing'),
      priority: 'normal',
      status: 'new',
      unitId: s.unit.id,
      description: null,
      requestedStartsAt: new Date(window.startsAt),
      requestedEndsAt: new Date(window.endsAt),
    });
    await assign(id);
    for (const [base, token] of [
      ['/tickets', s.owner.token],
      ['/technician/tickets', s.techs[0].token],
      ['/maintenance/tickets', s.supervisor.token],
    ]) {
      const detail = await d.http('get', `${base}/${id}`, token).expect(200);
      expect(detail.body).toMatchObject({
        kind: 'preventive',
        preventiveService: { key: 'plumbing_check', nameEn: 'Plumbing check' },
        requestedStartsAt: window.startsAt,
        requestedEndsAt: window.endsAt,
        description: '',
      });
      const list = await d.http('get', base, token).expect(200);
      expect(
        (list.body as { data: { id: string }[] }).data.find((t) => t.id === id),
      ).toMatchObject({
        kind: 'preventive',
        requestedStartsAt: window.startsAt,
      });
    }
    // A repair says so, and has no request.
    const repair = await d.openTicket(s);
    const seen = await d
      .http('get', `/tickets/${repair}`, s.owner.token)
      .expect(200);
    expect(seen.body).toMatchObject({
      kind: 'repair',
      preventiveService: null,
      requestedStartsAt: null,
      requestedEndsAt: null,
    });
  });

  it('the note is the description, and the room may be given', async () => {
    const id = await requested({
      note: '  The heater rattles  ',
      unitLocation: 'bathroom',
    });
    expect(await d.ticketRow(s.c, id)).toMatchObject({
      description: 'The heater rattles',
      unitLocation: 'bathroom',
    });
  });

  it('refuses a window outside the visiting hours, a retired service and a service whose category is retired', async () => {
    // An hour before the day's first slot: a valid visit window, not a
    // valid request.
    const first = slots[0];
    const early = {
      startsAt: new Date(
        new Date(first.startsAt).getTime() - 60 * MINUTE,
      ).toISOString(),
      endsAt: first.startsAt,
    };
    const outside = await request(early).expect(400);
    expect((outside.body as { fields: unknown[] }).fields).toEqual([
      { field: 'startsAt', code: 'VISIT_OUTSIDE_HOURS' },
    ]);

    const service = (
      (
        await d
          .http('post', '/maintenance/preventive-services', s.manager.token, {
            key: 'doors_check',
            nameAr: 'فحص الأبواب',
            nameEn: 'Doors check',
            categoryId: await d.categoryId(s.c, 'carpentry'),
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    const carpentry = await d.categoryId(s.c, 'carpentry');
    const patch = (path: string, body: object) =>
      d.http('patch', path, s.manager.token, body).expect(200);
    await patch(`/maintenance/categories/${carpentry}`, { active: false });
    const viaRetiredCategory = await request({ serviceId: service }).expect(
      404,
    );
    await patch(`/maintenance/categories/${carpentry}`, { active: true });
    await patch(`/maintenance/preventive-services/${service}`, {
      active: false,
    });
    const retired = await request({ serviceId: service }).expect(404);
    for (const res of [viaRetiredCategory, retired])
      expect((res.body as { code: string }).code).toBe(
        'PREVENTIVE_SERVICE_NOT_FOUND',
      );
  });

  it('a retried request with the same Idempotency-Key is one ticket', async () => {
    const body = slot();
    const key = `preventive-${Date.now()}`;
    const first = await request(body, s.owner, key).expect(201);
    const again = await request(body, s.owner, key).expect(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect((again.body as { id: string }).id).toBe(
      (first.body as { id: string }).id,
    );
  });

  // --- the automatic proposal ------------------------------------------------

  it('when a technician takes it, the window is proposed from the residents’ side: the system’s act, in the reporter’s name; the technician confirms it', async () => {
    const window = slots[next];
    const id = await requested();
    expect(await visits(id)).toEqual([]);
    await assign(id);
    const [visit, ...more] = await visits(id);
    expect(more).toEqual([]);
    expect(visit).toMatchObject({
      status: 'proposed',
      technicianId: s.techs[0].id,
      proposedBySide: 'resident',
      proposedById: s.owner.id,
      startsAt: new Date(window.startsAt),
      endsAt: new Date(window.endsAt),
    });
    // Nobody did this now: the history says the system, and why.
    expect(await events(id)).toEqual([
      ['proposed', 'system', null, 'preventive_request'],
    ]);
    // The technician is told twice, for two different things; never the unit.
    expect(
      (await notes(id, 'ticket.assigned')).map((n) => n.accountId),
    ).toEqual([s.techs[0].id]);
    const told = await notes(id, 'ticket.visit_proposed');
    expect(told.map((n) => n.accountId)).toEqual([s.techs[0].id]);
    expect(Object.keys(told[0].params as object).sort()).toEqual([
      'endsAt',
      'startsAt',
      'ticketNumber',
    ]);
    await d
      .http(
        'post',
        `/technician/tickets/${id}/visits/${visit.id}/confirm`,
        s.techs[0].token,
      )
      .expect(204);
    expect((await visits(id))[0].status).toBe('confirmed');
  });

  it('the dispatch engine’s assignment proposes it too', async () => {
    const auto = await d.setUp(1);
    await d.specialize(auto, auto.techs[0], ['electrical']);
    await d.setAvailability(auto.c, auto.techs[0].id, 'available');
    await d.setAutoDispatch(auto.c, true);
    const res = await d
      .http(
        'get',
        `/preventive-slots?unitId=${auto.unit.id}&days=3`,
        auto.owner.token,
      )
      .expect(200);
    const window = (res.body as { data: Slot[] }).data.at(-1)!;
    const created = await d
      .http('post', '/tickets/preventive', auto.owner.token, {
        unitId: auto.unit.id,
        serviceId: await serviceId('electrical_check', auto.c),
        ...window,
      })
      .expect(201);
    const { id, status } = created.body as { id: string; status: string };
    expect(status).toBe('assigned');
    expect(
      await d.inTenant(auto.c, (tx) =>
        tx.ticketVisit.findMany({ where: { ticketId: id } }),
      ),
    ).toMatchObject([
      {
        status: 'proposed',
        proposedBySide: 'resident',
        technicianId: auto.techs[0].id,
        startsAt: new Date(window.startsAt),
      },
    ]);
  });

  it('a reassignment before anyone answered: the old proposal ends, the new technician gets the same window', async () => {
    const id = await requested();
    await assign(id);
    await reassign(id, s.techs[1]);
    const all = await visits(id);
    expect(all).toMatchObject([
      {
        status: 'cancelled',
        cancelReasonCode: 'technician_changed',
        technicianId: s.techs[0].id,
      },
      { status: 'proposed', technicianId: s.techs[1].id },
    ]);
    expect(all[1].startsAt).toEqual(all[0].startsAt);
    // And once more, back: the request still stands.
    await reassign(id, s.techs[0]);
    expect((await visits(id)).map((v) => v.status)).toEqual([
      'cancelled',
      'cancelled',
      'proposed',
    ]);
  });

  it.each([
    [
      'the resident withdrew it',
      (id: string, visitId: string) =>
        d
          .http(
            'post',
            `/tickets/${id}/visits/${visitId}/cancel`,
            s.owner.token,
            { reasonCode: 'schedule_conflict' },
          )
          .expect(204),
    ],
    [
      'the technician cancelled it',
      (id: string, visitId: string) =>
        d
          .http(
            'post',
            `/technician/tickets/${id}/visits/${visitId}/cancel`,
            s.techs[0].token,
            { reasonCode: 'schedule_conflict' },
          )
          .expect(204),
    ],
    [
      'the technician countered it',
      (id: string, visitId: string) =>
        d
          .http(
            'post',
            `/technician/tickets/${id}/visits/${visitId}/counter`,
            s.techs[0].token,
            slot(),
          )
          .expect(201),
    ],
    [
      'the technician confirmed it',
      (id: string, visitId: string) =>
        d
          .http(
            'post',
            `/technician/tickets/${id}/visits/${visitId}/confirm`,
            s.techs[0].token,
          )
          .expect(204),
    ],
  ])(
    'once %s, the request is history: the next technician gets no automatic proposal',
    async (_what, answer) => {
      const id = await requested();
      await assign(id);
      const [visit] = await visits(id);
      await answer(id, visit.id);
      const before = (await visits(id)).length;
      await reassign(id, s.techs[1]);
      const after = await visits(id);
      expect(after).toHaveLength(before);
      expect(after.filter((v) => v.technicianId === s.techs[1].id)).toEqual([]);
    },
  );

  it('no proposal once the window is less than 15 minutes away, or when the reporter left', async () => {
    // The window went by before dispatch got to it. Only a superuser with
    // the triggers off can move what was asked for.
    const stale = await requested();
    const db = new Client({
      connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
    });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query('SET LOCAL session_replication_role = replica');
      await db.query(
        `UPDATE tickets
            SET requested_starts_at = now() + interval '10 minutes',
                requested_ends_at = now() + interval '70 minutes'
          WHERE id = $1`,
        [stale],
      );
      await db.query('COMMIT');
    } finally {
      await db.end();
    }
    await assign(stale);
    expect(await visits(stale)).toEqual([]);

    // Nobody proposes in the name of someone who left.
    const other = await d.x.resident(s.c, [s.unit.id]);
    const leaving = await d.who(s.c, other.id, 'resident');
    const id = await requested({}, leaving);
    const occupancy = (await d.x.occupancies(s.c, s.unit.id)).find(
      (o) => o.accountId === leaving.id && o.status === 'active',
    )!;
    await d.x.asManager(s.c, () =>
      h.moduleRef
        .get(ResidentsService)
        .endOccupancy(occupancy.id, { code: 'moved_out', text: 'Left' }),
    );
    await assign(id);
    expect(await visits(id)).toEqual([]);
  });

  // --- what never changes, and what is never measured ------------------------

  it('what was asked for never changes: the database refuses, whatever the role', async () => {
    const id = await requested();
    const attempts: Record<string, unknown>[] = [
      { kind: 'repair' },
      { requestedStartsAt: new Date(Date.now() + 5 * 24 * 60 * MINUTE) },
      { preventiveServiceId: await serviceId('ac_service') },
    ];
    for (const data of attempts)
      await expect(
        d.inTenant(s.c, (tx) => tx.ticket.update({ where: { id }, data })),
      ).rejects.toThrow(/kind and request never change/);
    // Everything else about the ticket still moves.
    await assign(id);
    expect((await d.ticketRow(s.c, id)).status).toBe('assigned');
  });

  it('a retired service keeps its name on the tickets that asked for it', async () => {
    const created = await d
      .http('post', '/maintenance/preventive-services', s.manager.token, {
        key: 'chimney_check',
        nameAr: 'فحص المدخنة',
        nameEn: 'Chimney check',
        categoryId: await d.categoryId(s.c, 'general'),
      })
      .expect(201);
    const service = (created.body as { id: string }).id;
    const id = await requested({ serviceId: service });
    await d
      .http(
        'patch',
        `/maintenance/preventive-services/${service}`,
        s.manager.token,
        { active: false },
      )
      .expect(200);
    const seen = await d
      .http('get', `/tickets/${id}`, s.owner.token)
      .expect(200);
    expect(seen.body).toMatchObject({
      preventiveService: { key: 'chimney_check', nameEn: 'Chimney check' },
    });
  });

  it('the SLA does not measure a preventive ticket: no clock, no breach, nothing to escalate, and the activation pass leaves it alone', async () => {
    const before = await requested();
    await d
      .http('patch', '/maintenance/sla-settings', s.manager.token, {
        slaEnabled: true,
      })
      .expect(200);
    const sweep = h.moduleRef.get(SlaSweep);
    await d.x.asManager(s.c, () => sweep.pass());
    const after = await requested();
    await assign(after);
    for (const verb of ['start', 'complete'])
      await d
        .http('post', `/technician/tickets/${after}/${verb}`, s.techs[0].token)
        .expect(204);
    for (const id of [before, after]) {
      expect(await slaEvents(id)).toEqual([]);
      expect(await slaClocks(id)).toEqual([]);
    }
    // A pass with nothing to do finds nothing: a preventive ticket is not
    // "a ticket without its clocks".
    expect(await d.x.asManager(s.c, () => sweep.pass())).toBe(0);
    const seen = await d
      .http('get', `/tickets/${before}`, s.owner.token)
      .expect(200);
    expect(seen.body).toMatchObject({ sla: null, canEscalate: false });
    const escalated = await d
      .http('post', `/tickets/${before}/escalate`, s.owner.token)
      .expect(409);
    expect((escalated.body as { code: string }).code).toBe(
      'TICKET_NOT_OVERDUE',
    );
  });
});
