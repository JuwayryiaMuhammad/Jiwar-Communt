import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };

const MINUTE = 60_000;

/**
 * ADR 0038: the residents' side confirms the technician's arrival, once,
 * while the visit is at the door. The technician is told; nothing else
 * moves. Whoever reaches the ticket's visits may confirm (ADR 0034).
 */
describe('Maintenance — the residents confirm the arrival', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  /** An adult of the owner's household: reaches the visits, not the ticket. */
  let family: Who;
  /** A resident of another unit of the compound. */
  let neighbour: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
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

  const tech = () => s.techs[0];

  /** A visit confirmed 20 minutes from now: the technician may arrive. */
  async function confirmedVisit() {
    const id = await d.openTicket(s);
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: tech().id,
      })
      .expect(204);
    const start = Date.now() + 20 * MINUTE;
    const res = await d
      .http('post', `/technician/tickets/${id}/visits`, tech().token, {
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 60 * MINUTE).toISOString(),
      })
      .expect(201);
    const visitId = (res.body as { id: string }).id;
    await d
      .http('post', `/tickets/${id}/visits/${visitId}/confirm`, s.owner.token)
      .expect(204);
    return { id, visitId };
  }

  async function arrivedVisit() {
    const v = await confirmedVisit();
    await d
      .http(
        'post',
        `/technician/tickets/${v.id}/visits/${v.visitId}/arrive`,
        tech().token,
      )
      .expect(200);
    return v;
  }

  const confirmArrival = (who: Who, id: string, visitId: string) =>
    d.http(
      'post',
      `/tickets/${id}/visits/${visitId}/confirm-arrival`,
      who.token,
    );

  const code = (res: { body: unknown }) => (res.body as { code: string }).code;

  const events = (ticketId: string) =>
    d.inTenant(s.c, async (tx) =>
      (
        await tx.ticketVisitEvent.findMany({
          where: { ticketId },
          orderBy: [{ at: 'asc' }, { id: 'asc' }],
        })
      ).map((e) => [e.kind, e.actorSide, e.actorId]),
    );

  it('the reporter confirms; the technician is told the number and the window only', async () => {
    const { id, visitId } = await arrivedVisit();
    await confirmArrival(s.owner, id, visitId).expect(204);
    const row = await d.inTenant(s.c, (tx) =>
      tx.ticketVisit.findUniqueOrThrow({ where: { id: visitId } }),
    );
    expect(row).toMatchObject({
      status: 'arrived',
      arrivalConfirmedById: s.owner.id,
    });
    expect(row.arrivalConfirmedAt).not.toBeNull();
    expect((await events(id)).at(-1)).toEqual([
      'arrival_confirmed',
      'resident',
      s.owner.id,
    ]);
    // Nothing else moves: the arrival already started the ticket.
    expect((await d.ticketRow(s.c, id)).status).toBe('in_progress');
    const told = await d.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { targetId: id, kind: 'ticket.visit_arrival_confirmed' },
      }),
    );
    expect(told.map((n) => n.accountId)).toEqual([tech().id]);
    expect(Object.keys(told[0].params as object).sort()).toEqual([
      'endsAt',
      'startsAt',
      'ticketNumber',
    ]);
  });

  it('each audience sees it its way: residents the first name, the technician never who', async () => {
    const { id, visitId } = await arrivedVisit();
    await confirmArrival(family, id, visitId).expect(204);
    const mine = await d
      .http('get', `/tickets/${id}/visits`, family.token)
      .expect(200);
    const visit = (mine.body as { data: Record<string, unknown>[] }).data[0];
    expect(visit.arrivalConfirmedAt).toEqual(expect.any(String));
    expect(visit.arrivalConfirmedBy).toMatchObject({
      id: family.id,
      mine: true,
    });
    const owner = await d
      .http('get', `/tickets/${id}/visits`, s.owner.token)
      .expect(200);
    expect(
      (owner.body as { data: Record<string, unknown>[] }).data[0]
        .arrivalConfirmedBy,
    ).toMatchObject({ id: family.id, mine: false });
    const unit = await d
      .http('get', `/me/units/${s.unit.id}/visits`, family.token)
      .expect(200);
    expect(
      (unit.body as { data: Record<string, unknown>[] }).data.find(
        (v) => v.id === visitId,
      ),
    ).toMatchObject({ arrivalConfirmedBy: { id: family.id, mine: true } });
    const techView = await d
      .http('get', `/technician/tickets/${id}/visits`, tech().token)
      .expect(200);
    const tv = (techView.body as { data: Record<string, unknown>[] }).data[0];
    expect(tv.arrivalConfirmedAt).toEqual(expect.any(String));
    expect(tv).not.toHaveProperty('arrivalConfirmedBy');
    expect(JSON.stringify(techView.body)).not.toContain(family.id);
    const dispatch = await d
      .http('get', `/maintenance/tickets/${id}/visits`, s.supervisor.token)
      .expect(200);
    expect(
      (dispatch.body as { data: Record<string, unknown>[] }).data[0]
        .arrivalConfirmedBy,
    ).toMatchObject({ id: family.id });
  });

  it('only at the door: not before the arrival, not after the visit is done', async () => {
    const before = await confirmedVisit();
    const early = await confirmArrival(
      s.owner,
      before.id,
      before.visitId,
    ).expect(409);
    expect(code(early)).toBe('VISIT_INVALID_TRANSITION');
    const after = await arrivedVisit();
    await d
      .http(
        'post',
        `/technician/tickets/${after.id}/visits/${after.visitId}/done`,
        tech().token,
      )
      .expect(204);
    const late = await confirmArrival(s.owner, after.id, after.visitId).expect(
      409,
    );
    expect(code(late)).toBe('VISIT_INVALID_TRANSITION');
  });

  it('once: a second confirmation is refused, and two at once write one event', async () => {
    const { id, visitId } = await arrivedVisit();
    await confirmArrival(s.owner, id, visitId).expect(204);
    const again = await confirmArrival(family, id, visitId).expect(409);
    expect(code(again)).toBe('VISIT_ARRIVAL_ALREADY_CONFIRMED');
    for (let round = 0; round < 3; round++) {
      const v = await arrivedVisit();
      const results = await Promise.all([
        confirmArrival(s.owner, v.id, v.visitId),
        confirmArrival(family, v.id, v.visitId),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
      const confirmed = (await events(v.id)).filter(
        (e) => e[0] === 'arrival_confirmed',
      );
      expect(confirmed).toHaveLength(1);
    }
  });

  it('nobody else: another unit’s resident, the technician, another visit id', async () => {
    const { id, visitId } = await arrivedVisit();
    const other = await confirmArrival(neighbour, id, visitId).expect(404);
    expect(code(other)).toBe('TICKET_NOT_FOUND');
    await confirmArrival(tech(), id, visitId).expect(403);
    const second = await arrivedVisit();
    // A visit of another ticket, through this ticket's path.
    const wrong = await confirmArrival(s.owner, id, second.visitId).expect(404);
    expect(code(wrong)).toBe('VISIT_NOT_FOUND');
    const row = await d.inTenant(s.c, (tx) =>
      tx.ticketVisit.findUniqueOrThrow({ where: { id: visitId } }),
    );
    expect(row.arrivalConfirmedAt).toBeNull();
  });
});
