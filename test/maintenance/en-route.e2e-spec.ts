import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { SlaSweep } from '../../src/maintenance/sla/sla-sweep';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { slaEvents } from '../setup/sla';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

const MINUTE = 60_000;

/**
 * ADR 0038: "technician on the way". An optional step between assigned and
 * in_progress: `start` still works from assigned, and en_route allows what
 * assigned allows. The reporter is told; it is the SLA's response; it is
 * work in the technician's hands everywhere (release, reassignment,
 * workload).
 */
describe('Maintenance — the technician on the way', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(2);
  }, 90_000);

  afterAll(() => h.close());

  const tech = () => s.techs[0];
  const code = (res: { body: unknown }) => (res.body as { code: string }).code;

  async function assigned(to = tech()): Promise<string> {
    const id = await d.openTicket(s);
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: to.id,
      })
      .expect(204);
    return id;
  }

  const act = (id: string, verb: string, token = tech().token, body?: object) =>
    d.http('post', `/technician/tickets/${id}/${verb}`, token, body);

  it('assigned → en_route → in_progress: history, the reporter told, every view shows it', async () => {
    const id = await assigned();
    await act(id, 'en-route').expect(204);
    expect((await d.ticketRow(s.c, id)).status).toBe('en_route');
    const history = await d.inTenant(s.c, (tx) =>
      tx.ticketStatusHistory.findMany({
        where: { ticketId: id, toStatus: 'en_route' },
      }),
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromStatus: 'assigned',
      actorId: tech().id,
    });
    const told = await d.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { targetId: id, kind: 'ticket.status_changed' },
      }),
    );
    expect(told.map((n) => [n.accountId, n.params])).toContainEqual([
      s.owner.id,
      expect.objectContaining({ status: 'en_route' }),
    ]);
    for (const [path, token] of [
      [`/tickets/${id}`, s.owner.token],
      [`/technician/tickets/${id}`, tech().token],
      [`/maintenance/tickets/${id}`, s.supervisor.token],
    ])
      expect(
        (
          (await d.http('get', path, token).expect(200)).body as {
            status: string;
          }
        ).status,
      ).toBe('en_route');
    await act(id, 'start').expect(204);
    expect((await d.ticketRow(s.c, id)).status).toBe('in_progress');
  });

  it('optional: start still works straight from assigned', async () => {
    const id = await assigned();
    await act(id, 'start').expect(204);
    expect((await d.ticketRow(s.c, id)).status).toBe('in_progress');
  });

  it('only from assigned: not twice, not once the work started', async () => {
    const id = await assigned();
    await act(id, 'en-route').expect(204);
    const twice = await act(id, 'en-route').expect(409);
    expect(code(twice)).toBe('TICKET_INVALID_TRANSITION');
    await act(id, 'start').expect(204);
    const started = await act(id, 'en-route').expect(409);
    expect(code(started)).toBe('TICKET_INVALID_TRANSITION');
    const queued = await d.openTicket(s);
    // Nobody's yet: not the technician's to see.
    await act(queued, 'en-route').expect(404);
  });

  it('only the ticket’s technician: another technician gets 404, a resident 403', async () => {
    const id = await assigned();
    const other = await act(id, 'en-route', s.techs[1].token).expect(404);
    expect(code(other)).toBe('TICKET_NOT_FOUND');
    await act(id, 'en-route', s.owner.token).expect(403);
    expect((await d.ticketRow(s.c, id)).status).toBe('assigned');
  });

  it('allows what assigned allows: decline, the reporter’s cancel, a reassignment', async () => {
    const declined = await assigned();
    await act(declined, 'en-route').expect(204);
    await act(declined, 'decline', tech().token, {
      reasonCode: 'not_my_specialty',
    }).expect(204);
    expect(await d.ticketRow(s.c, declined)).toMatchObject({
      status: 'new',
      technicianId: null,
    });

    const cancelled = await assigned();
    await act(cancelled, 'en-route').expect(204);
    await d
      .http('post', `/tickets/${cancelled}/cancel`, s.owner.token, {
        reasonCode: 'reporter_request',
      })
      .expect(204);
    expect((await d.ticketRow(s.c, cancelled)).status).toBe('cancelled');

    const moved = await assigned();
    await act(moved, 'en-route').expect(204);
    await d
      .http(
        'post',
        `/maintenance/tickets/${moved}/reassign`,
        s.supervisor.token,
        { technicianId: s.techs[1].id, reasonCode: 'workload' },
      )
      .expect(204);
    expect(await d.ticketRow(s.c, moved)).toMatchObject({
      status: 'assigned',
      technicianId: s.techs[1].id,
    });
  });

  it('a visit’s arrival starts an en-route ticket', async () => {
    const id = await assigned();
    const start = Date.now() + 20 * MINUTE;
    const visit = await d
      .http('post', `/technician/tickets/${id}/visits`, tech().token, {
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 60 * MINUTE).toISOString(),
      })
      .expect(201);
    const visitId = (visit.body as { id: string }).id;
    await d
      .http('post', `/tickets/${id}/visits/${visitId}/confirm`, s.owner.token)
      .expect(204);
    await act(id, 'en-route').expect(204);
    await act(id, `visits/${visitId}/arrive`).expect(200);
    expect((await d.ticketRow(s.c, id)).status).toBe('in_progress');
  });

  it('weighs on the technician like work in progress', async () => {
    const fresh = await d.who(
      s.c,
      (await d.g.guard(s.c, 'technician')).id,
      'staff',
    );
    const id = await assigned(fresh);
    const workload = async () =>
      (
        (
          await d
            .http('get', '/maintenance/technicians', s.supervisor.token)
            .expect(200)
        ).body as { data: { id: string; workload: number }[] }
      ).data.find((t) => t.id === fresh.id)!.workload;
    // The defaults (ADR 0033): assigned 1, in progress 2, normal × 1.
    expect(await workload()).toBe(1);
    await act(id, 'en-route', fresh.token).expect(204);
    expect(await workload()).toBe(2);
  });

  it('is the SLA’s response', async () => {
    const cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
    await d
      .http('patch', '/maintenance/sla-settings', s.manager.token, {
        slaEnabled: true,
      })
      .expect(200);
    try {
      await cls.run(async () => {
        cls.set('tenantId', s.c.tenantId);
        await h.moduleRef.get(SlaSweep).pass();
      });
      const id = await assigned();
      await act(id, 'en-route').expect(204);
      const response = (await slaEvents(id)).filter(
        (e) => e.clock === 'response',
      );
      expect(response.map((e) => e.kind)).toEqual(['started', 'met']);
      // Starting the work afterwards meets nothing twice.
      await act(id, 'start').expect(204);
      expect(
        (await slaEvents(id))
          .filter((e) => e.clock === 'response')
          .map((e) => e.kind),
      ).toEqual(['started', 'met']);
    } finally {
      await d
        .http('patch', '/maintenance/sla-settings', s.manager.token, {
          slaEnabled: false,
        })
        .expect(200);
    }
  });

  it('the database refuses an en-route ticket without a technician', async () => {
    const id = await assigned();
    await act(id, 'en-route').expect(204);
    await expect(
      d.inTenant(s.c, (tx) =>
        tx.ticket.update({
          where: { id },
          data: { technicianId: null, assignedAt: null },
        }),
      ),
    ).rejects.toThrow(/tickets_technician_matches_status/);
  });
});
