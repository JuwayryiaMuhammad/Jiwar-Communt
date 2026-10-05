import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { SlaSweep } from '../../src/maintenance/sla/sla-sweep';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { slaEvents } from '../setup/sla';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };

const MINUTE = 60_000;

/**
 * ADR 0034: visits. The technician's side proposes; the other side confirms
 * or counter-proposes; a confirmed window that moves is a new proposal;
 * the technician arrives within the window, then done or no access. At
 * most one active visit per ticket; every write on one ticket's visits is
 * serialized by the ticket's lock.
 */
describe('Maintenance — visits', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  /** An adult of the owner's household: may consent, has no `tickets`. */
  let family: Who;
  /** A resident of another unit of the compound. */
  let neighbour: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(2);
    const joined = await d.x.joinFamily(s.c, s.unit.id, s.owner);
    family = {
      id: joined.id,
      token: await h.tokenFor({
        sub: joined.id,
        tid: s.c.tenantId,
        typ: 'family',
      }),
    };
    const other = await d.x.unit(s.c);
    const n = await d.x.resident(s.c, [other.id]);
    neighbour = await d.who(s.c, n.id, 'resident');
  }, 90_000);

  afterAll(() => h.close());

  // --- helpers ---------------------------------------------------------------

  const tech = () => s.techs[0];

  /** A window `inMinutes` from now, `minutes` long. */
  const window = (inMinutes = 24 * 60, minutes = 60) => {
    const start = Date.now() + inMinutes * MINUTE;
    return {
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + minutes * MINUTE).toISOString(),
    };
  };

  async function assigned(): Promise<string> {
    const id = await d.openTicket(s);
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: tech().id,
      })
      .expect(204);
    return id;
  }

  const propose = (id: string, body = window(), who = tech()) =>
    d.http('post', `/technician/tickets/${id}/visits`, who.token, body);

  const asTech = (id: string, visitId: string, verb: string, body?: object) =>
    d.http(
      'post',
      `/technician/tickets/${id}/visits/${visitId}/${verb}`,
      tech().token,
      body,
    );

  const asResident = (
    who: Who,
    id: string,
    visitId: string,
    verb: string,
    body?: object,
  ) =>
    d.http('post', `/tickets/${id}/visits/${visitId}/${verb}`, who.token, body);

  const visitRow = (visitId: string) =>
    d.inTenant(s.c, (tx) =>
      tx.ticketVisit.findUniqueOrThrow({ where: { id: visitId } }),
    );

  const events = (ticketId: string) =>
    d.inTenant(s.c, async (tx) =>
      (
        await tx.ticketVisitEvent.findMany({
          where: { ticketId },
          orderBy: [{ at: 'asc' }, { id: 'asc' }],
        })
      ).map((e) => [e.kind, e.actorSide, e.reasonCode]),
    );

  const notes = (ticketId: string, kind: string) =>
    d.inTenant(s.c, (tx) =>
      tx.notification.findMany({ where: { targetId: ticketId, kind } }),
    );

  /** Moves a visit's window (the row is mutable; setup, not a test). */
  const shift = (visitId: string, byMinutes: number) =>
    d.inTenant(s.c, async (tx) => {
      const v = await tx.ticketVisit.findUniqueOrThrow({
        where: { id: visitId },
      });
      await tx.ticketVisit.update({
        where: { id: visitId },
        data: {
          startsAt: new Date(v.startsAt.getTime() + byMinutes * MINUTE),
          endsAt: new Date(v.endsAt.getTime() + byMinutes * MINUTE),
        },
      });
    });

  async function confirmedVisit(inMinutes = 20) {
    const id = await assigned();
    const res = await propose(id, window(inMinutes)).expect(201);
    const visitId = (res.body as { id: string }).id;
    await asResident(s.owner, id, visitId, 'confirm').expect(204);
    return { id, visitId };
  }

  // --- the state machine -------------------------------------------------------

  it('proposed → confirmed → arrived → done; the arrival starts the ticket and tells the residents', async () => {
    const { id, visitId } = await confirmedVisit();
    expect(await visitRow(visitId)).toMatchObject({
      status: 'confirmed',
      confirmedById: s.owner.id,
      absenceEntryApproved: false,
    });
    const arrived = await asTech(id, visitId, 'arrive').expect(200);
    expect(arrived.body).toMatchObject({
      status: 'arrived',
      absenceEntryApproved: false,
      receiver: null,
    });
    expect(await d.ticketRow(s.c, id)).toMatchObject({ status: 'in_progress' });
    // The 5.1 transition: the same history row a start writes.
    const history = await d.inTenant(s.c, (tx) =>
      tx.ticketStatusHistory.findMany({
        where: { ticketId: id, toStatus: 'in_progress' },
      }),
    );
    expect(history).toHaveLength(1);
    expect(history[0].actorId).toBe(tech().id);
    const told = await notes(id, 'ticket.visit_arrived');
    expect(told.map((n) => n.accountId)).toEqual(
      expect.arrayContaining([s.owner.id, family.id]),
    );
    await asTech(id, visitId, 'done').expect(204);
    expect((await visitRow(visitId)).status).toBe('done');
    // The ticket goes on by its own rules.
    expect((await d.ticketRow(s.c, id)).status).toBe('in_progress');
    expect(await events(id)).toEqual([
      ['proposed', 'technician', null],
      ['confirmed', 'resident', null],
      ['arrived', 'technician', null],
      ['done', 'technician', null],
    ]);
  });

  it('no access: the ticket waits for the resident, and the residents are asked for a new time', async () => {
    const { id, visitId } = await confirmedVisit();
    await asTech(id, visitId, 'arrive').expect(200);
    await asTech(id, visitId, 'no-access').expect(204);
    expect((await visitRow(visitId)).status).toBe('no_access');
    expect(await d.ticketRow(s.c, id)).toMatchObject({
      status: 'on_hold',
      holdReason: 'awaiting_resident',
    });
    expect(
      (await notes(id, 'ticket.visit_no_access')).map((n) => n.accountId),
    ).toEqual(expect.arrayContaining([s.owner.id, family.id]));
    // A new visit may be proposed now.
    await propose(id).expect(201);
  });

  it('a counter-proposal ends the proposal and needs the technician’s confirmation', async () => {
    const id = await assigned();
    const first = (await propose(id).expect(201)).body as { id: string };
    const counter = await asResident(
      s.owner,
      id,
      first.id,
      'counter',
      window(48 * 60),
    ).expect(201);
    const second = counter.body as { id: string; status: string };
    expect(second.status).toBe('proposed');
    expect(await visitRow(first.id)).toMatchObject({
      status: 'rescheduled',
      cancelledBySide: 'resident',
      cancelReasonCode: null,
    });
    expect(await visitRow(second.id)).toMatchObject({
      proposedBySide: 'resident',
      previousVisitId: first.id,
    });
    // The side that proposed does not confirm its own window.
    const own = await asResident(s.owner, id, second.id, 'confirm').expect(403);
    expect((own.body as { code: string }).code).toBe('VISIT_SAME_SIDE');
    await asTech(id, second.id, 'confirm').expect(204);
    expect((await visitRow(second.id)).status).toBe('confirmed');
    expect(
      (await notes(id, 'ticket.visit_confirmed')).map((n) => n.accountId),
    ).toContain(s.owner.id);
  });

  it('a confirmed visit that moves is a new proposal; the old one ends rescheduled, with the code', async () => {
    const { id, visitId } = await confirmedVisit(60);
    const res = await asTech(id, visitId, 'reschedule', {
      ...window(3 * 60),
      reasonCode: 'parts_unavailable',
    }).expect(201);
    const next = res.body as { id: string };
    expect(await visitRow(visitId)).toMatchObject({
      status: 'rescheduled',
      cancelReasonCode: 'parts_unavailable',
      cancelledBySide: 'technician',
    });
    expect(await visitRow(next.id)).toMatchObject({
      status: 'proposed',
      proposedBySide: 'technician',
      previousVisitId: visitId,
    });
    // Only a confirmed window is rescheduled; a proposal is answered.
    const proposed = await asTech(id, next.id, 'reschedule', {
      ...window(),
      reasonCode: 'other',
    }).expect(409);
    expect((proposed.body as { code: string }).code).toBe(
      'VISIT_INVALID_TRANSITION',
    );
    const bad = await asResident(s.owner, id, next.id, 'reschedule', {
      ...window(),
      reasonCode: 'because',
    }).expect(400);
    expect((bad.body as { fields: { code: string }[] }).fields[0].code).toBe(
      'INVALID_REASON_CODE',
    );
  });

  it('either side cancels with a code from the closed list; the other side is told', async () => {
    const { id, visitId } = await confirmedVisit(60);
    const bad = await asResident(s.owner, id, visitId, 'cancel', {
      reasonCode: 'bored',
    }).expect(400);
    expect((bad.body as { fields: { code: string }[] }).fields[0].code).toBe(
      'INVALID_REASON_CODE',
    );
    await asResident(s.owner, id, visitId, 'cancel', {
      reasonCode: 'resident_request',
    }).expect(204);
    expect(await visitRow(visitId)).toMatchObject({
      status: 'cancelled',
      cancelledBySide: 'resident',
      cancelledById: s.owner.id,
    });
    expect(
      (await notes(id, 'ticket.visit_cancelled')).map((n) => n.accountId),
    ).toEqual([tech().id]);
    await asTech(id, visitId, 'arrive').expect(409);
  });

  it('a dispatcher acts on the technician’s side, and the technician is told', async () => {
    const id = await assigned();
    const res = await d
      .http(
        'post',
        `/maintenance/tickets/${id}/visits`,
        s.supervisor.token,
        window(),
      )
      .expect(201);
    const visitId = (res.body as { id: string }).id;
    expect(await visitRow(visitId)).toMatchObject({
      proposedBySide: 'technician',
      proposedById: s.supervisor.id,
      technicianId: tech().id,
    });
    expect(
      (await notes(id, 'ticket.visit_proposed')).map((n) => n.accountId),
    ).toEqual(expect.arrayContaining([tech().id, s.owner.id]));
  });

  // --- what a window must be ----------------------------------------------------

  it('a window starts 15 minutes to 30 days from now (the database’s clock) and lasts at most 4 hours', async () => {
    const id = await assigned();
    const fields = async (body: object) =>
      (
        (await propose(id, body as ReturnType<typeof window>).expect(400))
          .body as { fields: { field: string; code: string }[] }
      ).fields.map((f) => [f.field, f.code]);
    expect(await fields(window(5))).toEqual([['startsAt', 'VISIT_TOO_SOON']]);
    expect(await fields(window(31 * 24 * 60))).toEqual([
      ['startsAt', 'VISIT_TOO_FAR'],
    ]);
    expect(await fields(window(60, 241))).toEqual([
      ['endsAt', 'VISIT_TOO_LONG'],
    ]);
    expect(await fields(window(60, 0))).toEqual([
      ['endsAt', 'VISIT_ENDS_BEFORE_START'],
    ]);
    await propose(id, window(60, 240)).expect(201);
  });

  it('the arrival is marked from 30 minutes before the start to 2 hours after the end', async () => {
    const early = await confirmedVisit(120);
    const res = await asTech(early.id, early.visitId, 'arrive').expect(409);
    expect((res.body as { code: string }).code).toBe(
      'VISIT_OUTSIDE_ARRIVAL_WINDOW',
    );
    const late = await confirmedVisit(20);
    // The window passed: it ended more than two hours ago.
    await shift(late.visitId, -(20 + 60 + 121));
    await asTech(late.id, late.visitId, 'arrive').expect(409);
    await shift(late.visitId, 2);
    await asTech(late.id, late.visitId, 'arrive').expect(200);
  });

  it('a ticket in the queue, a closed ticket and a common area have no visits', async () => {
    const queued = await d.openTicket(s);
    const res = await d
      .http(
        'post',
        `/maintenance/tickets/${queued}/visits`,
        s.supervisor.token,
        window(),
      )
      .expect(409);
    expect((res.body as { code: string }).code).toBe(
      'TICKET_INVALID_TRANSITION',
    );
    const area = await d
      .http('post', '/maintenance/tickets', s.supervisor.token, {
        commonArea: 'Lobby',
        categoryId: await d.categoryId(s.c, 'general'),
        description: 'Common area',
        reporterAccountId: s.owner.id,
      })
      .expect(201);
    const areaId = (area.body as { id: string }).id;
    await d
      .http(
        'post',
        `/maintenance/tickets/${areaId}/assign`,
        s.supervisor.token,
        {
          technicianId: tech().id,
        },
      )
      .expect(204);
    const none = await propose(areaId).expect(409);
    expect((none.body as { code: string }).code).toBe(
      'VISIT_NOT_FOR_COMMON_AREA',
    );
  });

  // --- who sees and acts --------------------------------------------------------

  it('an adult of the household sees and answers the visits, never the ticket itself', async () => {
    const id = await assigned();
    const visitId = ((await propose(id).expect(201)).body as { id: string }).id;
    // The ticket stays the reporter's (ADR 0032)…
    await d.http('get', `/tickets/${id}`, family.token).expect(404);
    // …its visits are everyone's who lives there.
    const list = await d
      .http('get', `/tickets/${id}/visits`, family.token)
      .expect(200);
    expect(
      (list.body as { data: { id: string }[] }).data.map((v) => v.id),
    ).toEqual([visitId]);
    expect(list.headers['cache-control']).toContain('no-store');
    const unit = await d
      .http('get', `/me/units/${s.unit.id}/visits`, family.token)
      .expect(200);
    const listed = (unit.body as { data: Record<string, unknown>[] }).data;
    expect(listed.map((v) => v.id)).toContain(visitId);
    expect(listed.find((v) => v.id === visitId)).toMatchObject({
      ticketId: id,
      ticketStatus: 'assigned',
      status: 'proposed',
    });
    expect(listed[0]).not.toHaveProperty('description');
    await asResident(family, id, visitId, 'confirm').expect(204);
    expect((await visitRow(visitId)).confirmedById).toBe(family.id);
  });

  it('a resident of another unit sees nothing; a technician sees only their own visits', async () => {
    const id = await assigned();
    const visitId = ((await propose(id).expect(201)).body as { id: string }).id;
    await d.http('get', `/tickets/${id}/visits`, neighbour.token).expect(404);
    await asResident(neighbour, id, visitId, 'confirm').expect(404);
    const unit = await d
      .http('get', `/me/units/${s.unit.id}/visits`, neighbour.token)
      .expect(404);
    expect((unit.body as { code: string }).code).toBe('UNIT_NOT_FOUND');
    const other = s.techs[1];
    await d
      .http('get', `/technician/tickets/${id}/visits`, other.token)
      .expect(404);
    await d
      .http(
        'post',
        `/technician/tickets/${id}/visits/${visitId}/arrive`,
        other.token,
      )
      .expect(404);
  });

  it('notices carry the ticket number and the window, never the unit', async () => {
    const id = await assigned();
    await propose(id).expect(201);
    const sent = await notes(id, 'ticket.visit_proposed');
    expect(sent.length).toBeGreaterThan(0);
    for (const n of sent)
      expect(Object.keys(n.params as object).sort()).toEqual([
        'endsAt',
        'startsAt',
        'ticketNumber',
      ]);
  });

  it('dispatch reads the visit history, with who did what and never a window', async () => {
    const { id } = await confirmedVisit(60);
    const res = await d
      .http(
        'get',
        `/maintenance/tickets/${id}/visit-events`,
        s.supervisor.token,
      )
      .expect(200);
    const rows = (res.body as { data: Record<string, unknown>[] }).data;
    expect(rows.map((r) => r.kind)).toEqual(['proposed', 'confirmed']);
    expect(rows[1]).toMatchObject({
      actorSide: 'resident',
      actor: { id: s.owner.id },
    });
    for (const r of rows) {
      expect(r).not.toHaveProperty('startsAt');
      expect(r).not.toHaveProperty('endsAt');
    }
    await d
      .http('get', `/maintenance/tickets/${id}/visit-events`, tech().token)
      .expect(403);
  });

  // --- the SLA's response ---------------------------------------------------------

  it('a proposal from the technician’s side meets the SLA response', async () => {
    const cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
    await d
      .http('patch', '/maintenance/sla-settings', s.manager.token, {
        slaEnabled: true,
      })
      .expect(200);
    await cls.run(async () => {
      cls.set('tenantId', s.c.tenantId);
      await h.moduleRef.get(SlaSweep).pass();
    });
    const id = await assigned();
    await propose(id).expect(201);
    const response = (await slaEvents(id)).filter(
      (e) => e.clock === 'response',
    );
    expect(response.map((e) => e.kind)).toEqual(['started', 'met']);
    await d
      .http('patch', '/maintenance/sla-settings', s.manager.token, {
        slaEnabled: false,
      })
      .expect(200);
  });

  // --- races ---------------------------------------------------------------------

  it('two proposals at once: one visit, never two active', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await assigned();
      const results = await Promise.all([
        propose(id, window(60)),
        d.http(
          'post',
          `/maintenance/tickets/${id}/visits`,
          s.supervisor.token,
          window(90),
        ),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect((loser.body as { code: string }).code).toBe(
        'VISIT_ALREADY_ACTIVE',
      );
      const active = await d.inTenant(s.c, (tx) =>
        tx.ticketVisit.count({
          where: {
            ticketId: id,
            status: { in: ['proposed', 'confirmed', 'arrived'] },
          },
        }),
      );
      expect(active).toBe(1);
    }
  });

  it('a confirmation and a cancellation at once: one order or the other, never a half state', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await assigned();
      const visitId = ((await propose(id).expect(201)).body as { id: string })
        .id;
      const [confirm, cancel] = await Promise.all([
        asResident(s.owner, id, visitId, 'confirm'),
        asTech(id, visitId, 'cancel', { reasonCode: 'technician_request' }),
      ]);
      expect(cancel.status).toBe(204);
      const row = await visitRow(visitId);
      expect(row.status).toBe('cancelled');
      const kinds = (await events(id)).map((e) => e[0]);
      if (confirm.status === 204)
        expect(kinds).toEqual(['proposed', 'confirmed', 'cancelled']);
      else {
        expect(confirm.status).toBe(409);
        expect(kinds).toEqual(['proposed', 'cancelled']);
        expect(row.confirmedAt).toBeNull();
      }
    }
  });
});
