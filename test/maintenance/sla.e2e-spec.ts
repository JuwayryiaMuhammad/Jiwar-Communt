import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { SLA_SWEEP, SlaSweep } from '../../src/maintenance/sla/sla-sweep';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  rebuildEveryClock,
  rewind,
  setTenantStatus,
  slaClocks,
  slaEvents,
  type EventRow,
} from '../setup/sla';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

const MINUTE = 60_000;
const DAY = 24 * 60;

/**
 * ADR 0034: the SLA, event by event. Response is met by the work starting
 * (a visit proposal: visits.e2e-spec.ts), never by an assignment;
 * resolution pauses on the two hold reasons and while the work waits for
 * confirmation, resumes on a rejection, is met at close; a reopen is a new
 * cycle; a priority or category change retargets; a breach is recorded at
 * exactly its due time, once.
 */
describe('Maintenance — the SLA clocks', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let cls: ClsService<AppClsStore>;
  let s: SetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
    s = await d.setUp(1);
    await enable(s);
  }, 60_000);

  afterAll(() => h.close());

  // --- helpers ---------------------------------------------------------------

  const inCompound = <T>(c: SetUp['c'], fn: () => Promise<T>) =>
    cls.run(async () => {
      cls.set('tenantId', c.tenantId);
      return await fn();
    });

  async function enable(at: SetUp) {
    await d
      .http('patch', '/maintenance/sla-settings', at.manager.token, {
        slaEnabled: true,
      })
      .expect(200);
    await inCompound(at.c, () => h.moduleRef.get(SlaSweep).pass());
  }

  const sweep = (now = new Date()) =>
    h.moduleRef.get(SweepRunner).run(SLA_SWEEP, now);

  async function assigned(at = s, priority?: 'emergency'): Promise<string> {
    const id = await d.openTicket(at, priority ? { priority } : {});
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, at.supervisor.token, {
        technicianId: at.techs[0].id,
      })
      .expect(204);
    return id;
  }

  const work = (id: string, verb: string, body?: object, at = s) =>
    d.http(
      'post',
      `/technician/tickets/${id}/${verb}`,
      at.techs[0].token,
      body,
    );

  const resident = (id: string, verb: string, body: object, at = s) =>
    d.http('post', `/tickets/${id}/${verb}`, at.owner.token, body);

  /** The events as [clock, cycle, kind, reasonCode]. */
  const trail = async (id: string) =>
    (await slaEvents(id)).map((e: EventRow) => [
      e.clock,
      e.cycle,
      e.kind,
      e.reasonCode,
    ]);

  const clock = async (
    id: string,
    which: 'response' | 'resolution',
    cycle = 1,
  ) =>
    (await slaClocks(id)).find((c) => c.clock === which && c.cycle === cycle)!;

  const breaches = (c: SetUp['c'], ticketId: string) =>
    d.inTenant(c, (tx) =>
      tx.notification.findMany({
        where: {
          targetId: ticketId,
          kind: {
            in: ['ticket.sla_breached', 'ticket.sla_breached_emergency'],
          },
        },
      }),
    );

  // --- off by default ------------------------------------------------------

  it('is off in a new compound: nothing is recorded, whatever happens', async () => {
    const off = await d.setUp(1);
    const id = await assigned(off);
    await work(id, 'start', undefined, off).expect(204);
    await work(id, 'hold', { holdReason: 'awaiting_parts' }, off).expect(204);
    await work(id, 'resume', undefined, off).expect(204);
    await work(id, 'complete', undefined, off).expect(204);
    expect(await slaEvents(id)).toEqual([]);
    expect(await slaClocks(id)).toEqual([]);
    await sweep(new Date(Date.now() + 30 * DAY * MINUTE));
    expect(await slaEvents(id)).toEqual([]);
    const detail = await d
      .http('get', `/tickets/${id}`, off.owner.token)
      .expect(200);
    expect((detail.body as { sla: unknown }).sla).toBeNull();
  });

  it('turning it on starts open tickets’ clocks from that moment, never earlier', async () => {
    const later = await d.setUp(1);
    const queued = await d.openTicket(later);
    const started = await assigned(later);
    await work(started, 'start', undefined, later).expect(204);
    // An hour passes before the manager turns it on.
    await rewind(queued, 60);
    await rewind(started, 60);
    await enable(later);
    const settings = await d
      .http('get', '/maintenance/sla-settings', later.manager.token)
      .expect(200);
    const enabledAt = new Date(
      (settings.body as { enabledAt: string }).enabledAt,
    ).getTime();
    for (const id of [queued, started])
      for (const e of await slaEvents(id))
        expect(e.at.getTime()).toBeGreaterThanOrEqual(enabledAt);
    // The queued ticket has both clocks; the one already in progress was
    // responded to before: resolution only.
    expect(await trail(queued)).toEqual([
      ['resolution', 1, 'started', null],
      ['response', 1, 'started', null],
    ]);
    expect(await trail(started)).toEqual([['resolution', 1, 'started', null]]);
    // Running the pass again changes nothing.
    await inCompound(later.c, () => h.moduleRef.get(SlaSweep).pass());
    expect(await trail(queued)).toHaveLength(2);
  });

  // --- response --------------------------------------------------------------

  it('response: started at creation, not met by an assignment, met by the start of the work', async () => {
    const id = await d.openTicket(s);
    expect(await trail(id)).toEqual([
      ['resolution', 1, 'started', null],
      ['response', 1, 'started', null],
    ]);
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: s.techs[0].id,
      })
      .expect(204);
    expect((await clock(id, 'response')).state).toBe('running');
    await work(id, 'start').expect(204);
    expect((await clock(id, 'response')).state).toBe('met');
    expect(await trail(id)).toContainEqual(['response', 1, 'met', null]);
  });

  // --- pauses ------------------------------------------------------------------

  it.each(['awaiting_resident', 'awaiting_parts'])(
    'resolution pauses on hold for %s and resumes when the ticket leaves the hold',
    async (holdReason) => {
      const id = await assigned();
      await work(id, 'start').expect(204);
      await work(id, 'hold', { holdReason }).expect(204);
      const paused = await clock(id, 'resolution');
      expect(paused).toMatchObject({ state: 'paused', dueAt: null });
      await work(id, 'resume').expect(204);
      const resumed = await clock(id, 'resolution');
      expect(resumed.state).toBe('running');
      expect(await trail(id)).toEqual(
        expect.arrayContaining([
          ['resolution', 1, 'paused', holdReason],
          ['resolution', 1, 'resumed', 'left_hold'],
        ]),
      );
    },
  );

  it('a hold for another reason does not pause', async () => {
    const id = await assigned();
    await work(id, 'start').expect(204);
    await work(id, 'hold', { holdReason: 'other' }).expect(204);
    expect((await clock(id, 'resolution')).state).toBe('running');
    expect((await trail(id)).filter((e) => e[2] === 'paused')).toEqual([]);
  });

  it('a release from a pausing hold resumes the clock (the ticket left the hold)', async () => {
    const id = await assigned();
    await work(id, 'start').expect(204);
    await work(id, 'hold', { holdReason: 'awaiting_parts' }).expect(204);
    const other = await d.g.guard(s.c, 'technician');
    await d
      .http('post', `/maintenance/tickets/${id}/reassign`, s.supervisor.token, {
        technicianId: other.id,
        reasonCode: 'workload',
      })
      .expect(204);
    expect((await clock(id, 'resolution')).state).toBe('running');
  });

  // --- completion, rejection, close, reopen ---------------------------------------

  it('completion pauses resolution; a rejection resumes the same clock; a close meets it', async () => {
    const id = await assigned();
    await work(id, 'start').expect(204);
    await work(id, 'complete').expect(204);
    expect(await clock(id, 'resolution')).toMatchObject({ state: 'paused' });
    await resident(id, 'reject', {
      reasonCode: 'not_fixed',
      reason: 'Still dripping',
    }).expect(204);
    // The same cycle, resumed.
    expect(await clock(id, 'resolution')).toMatchObject({
      cycle: 1,
      state: 'running',
    });
    await work(id, 'start').expect(204);
    await work(id, 'complete').expect(204);
    await resident(id, 'confirm', { rating: 5 }).expect(204);
    expect(await clock(id, 'resolution')).toMatchObject({ state: 'met' });
    expect(
      (await trail(id)).filter((e) => e[0] === 'resolution').map((e) => e[2]),
    ).toEqual(['started', 'paused', 'resumed', 'paused', 'met']);
    expect(await trail(id)).toContainEqual([
      'resolution',
      1,
      'paused',
      'awaiting_confirmation',
    ]);
    expect(await trail(id)).toContainEqual([
      'resolution',
      1,
      'resumed',
      'rejected',
    ]);
  });

  it('a reopen after close starts a new cycle with new clocks', async () => {
    const id = await assigned();
    await work(id, 'start').expect(204);
    await work(id, 'complete').expect(204);
    await resident(id, 'confirm', { rating: 4 }).expect(204);
    await resident(id, 'reopen', {
      reasonCode: 'problem_returned',
      reason: 'It came back',
    }).expect(204);
    const cycle2 = (await trail(id)).filter((e) => e[1] === 2);
    expect(cycle2).toEqual([
      ['resolution', 2, 'started', null],
      ['response', 2, 'started', null],
    ]);
    expect((await clock(id, 'resolution', 1)).state).toBe('met');
  });

  it('a cancellation stops every clock', async () => {
    const id = await assigned();
    await d
      .http('post', `/maintenance/tickets/${id}/cancel`, s.supervisor.token, {
        reasonCode: 'duplicate',
      })
      .expect(204);
    expect(await trail(id)).toEqual(
      expect.arrayContaining([
        ['response', 1, 'stopped', 'ticket_cancelled'],
        ['resolution', 1, 'stopped', 'ticket_cancelled'],
      ]),
    );
  });

  // --- retargeting -------------------------------------------------------------

  it('a priority change retargets, measured from the same start', async () => {
    const id = await assigned();
    const before = await clock(id, 'resolution');
    await d
      .http('post', `/maintenance/tickets/${id}/priority`, s.supervisor.token, {
        priority: 'emergency',
        reasonCode: 'safety_risk',
      })
      .expect(204);
    const after = await clock(id, 'resolution');
    expect(after.targetMinutes).toBe(24 * 60);
    expect(after.dueAt!.getTime()).toBe(
      before.startedAt.getTime() + 24 * 60 * MINUTE,
    );
    expect(await trail(id)).toEqual(
      expect.arrayContaining([
        ['response', 1, 'retargeted', 'priority_changed'],
        ['resolution', 1, 'retargeted', 'priority_changed'],
      ]),
    );
  });

  it('a category change retargets to the new category’s targets', async () => {
    const plumbing = await d.categoryId(s.c, 'plumbing');
    await d
      .http(
        'put',
        `/maintenance/categories/${plumbing}/sla-targets`,
        s.manager.token,
        {
          emergency: { responseMinutes: 30, resolutionMinutes: 600 },
          urgent: { responseMinutes: 120, resolutionMinutes: 2880 },
          normal: { responseMinutes: 600, resolutionMinutes: 5000 },
        },
      )
      .expect(204);
    const id = await assigned();
    await d
      .http('post', `/maintenance/tickets/${id}/category`, s.supervisor.token, {
        categoryId: plumbing,
        reasonCode: 'misclassified',
      })
      .expect(204);
    expect(await clock(id, 'response')).toMatchObject({ targetMinutes: 600 });
    expect(await clock(id, 'resolution')).toMatchObject({
      targetMinutes: 5000,
    });
    expect(await trail(id)).toContainEqual([
      'resolution',
      1,
      'retargeted',
      'category_changed',
    ]);
  });

  // --- breaches ------------------------------------------------------------------

  it('the sweep records a breach at exactly the due time, once, and tells dispatch and the managers', async () => {
    const id = await assigned();
    await rewind(id, 25 * 60);
    const due = (await clock(id, 'response')).dueAt!;
    // Twice: the second run finds nothing more to do for this clock.
    await sweep();
    await sweep();
    const breached = (await slaEvents(id)).filter((e) => e.kind === 'breached');
    expect(breached).toHaveLength(1);
    expect(breached[0]).toMatchObject({ clock: 'response' });
    expect(breached[0].at.getTime()).toBe(due.getTime());
    expect((await clock(id, 'response')).state).toBe('breached');
    const notes = await breaches(s.c, id);
    expect(notes.map((n) => n.accountId).sort()).toEqual(
      [s.manager.id, s.supervisor.id].sort(),
    );
    for (const n of notes) {
      expect(n.kind).toBe('ticket.sla_breached');
      expect(Object.keys(n.params as object).sort()).toEqual([
        'clock',
        'ticketNumber',
      ]);
      expect(n.params).toMatchObject({ clock: 'response' });
    }
    // A breached clock takes no more events: the start of the work does
    // not meet it afterwards.
    await work(id, 'start').expect(204);
    expect((await clock(id, 'response')).state).toBe('breached');
  });

  it('an emergency’s breach is critical', async () => {
    const id = await assigned(s, 'emergency');
    await rewind(id, 61);
    await sweep();
    const notes = await breaches(s.c, id);
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      expect(n.kind).toBe('ticket.sla_breached_emergency');
      expect(n.priority).toBe('critical');
    }
  });

  it('a clock that is past due when the work starts is breached, not met: time decides, not who writes first', async () => {
    const id = await assigned();
    await rewind(id, 25 * 60);
    const due = (await clock(id, 'response')).dueAt!;
    // The sweep has not run yet; the technician starts the work.
    await work(id, 'start').expect(204);
    const response = (await slaEvents(id)).filter(
      (e) => e.clock === 'response',
    );
    expect(response.map((e) => e.kind)).toEqual(['started', 'breached']);
    expect(response[1].at.getTime()).toBe(due.getTime());
    await sweep();
    expect(
      (await slaEvents(id)).filter((e) => e.clock === 'response'),
    ).toHaveLength(2);
  });

  it('met and breached race: exactly one of them, for every round', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await assigned();
      // Due in about a second, either side of the race.
      await rewind(id, 24 * 60 - 0.02);
      const [res] = await Promise.all([
        work(id, 'start'),
        sweep(new Date(Date.now() + 5_000)),
      ]);
      expect(res.status).toBe(204);
      const ends = (await slaEvents(id)).filter(
        (e) =>
          e.clock === 'response' && (e.kind === 'met' || e.kind === 'breached'),
      );
      expect(ends).toHaveLength(1);
      if (ends[0].kind === 'breached')
        expect(ends[0].at.getTime()).toBe(
          (await clock(id, 'response')).endedAt!.getTime(),
        );
    }
  });

  it('a suspended compound is skipped; its breach is recorded at the due time once it is active again', async () => {
    const away = await d.setUp(1);
    await enable(away);
    const id = await assigned(away);
    await rewind(id, 25 * 60);
    const due = (await clock(id, 'response')).dueAt!;
    await setTenantStatus(away.c.tenantId, 'suspended');
    try {
      await sweep();
      expect((await clock(id, 'response')).state).toBe('running');
      expect(await breaches(away.c, id)).toEqual([]);
    } finally {
      await setTenantStatus(away.c.tenantId, 'active');
    }
    await sweep();
    const breached = (await slaEvents(id)).find(
      (e) => e.clock === 'response' && e.kind === 'breached',
    )!;
    expect(breached.at.getTime()).toBe(due.getTime());
  });

  // --- turning it off ----------------------------------------------------------

  it('turning it off stops the clocks; writers record nothing; the sweep breaches nothing', async () => {
    const off = await d.setUp(1);
    await enable(off);
    const id = await assigned(off);
    await d
      .http('patch', '/maintenance/sla-settings', off.manager.token, {
        slaEnabled: false,
      })
      .expect(200);
    await inCompound(off.c, () => h.moduleRef.get(SlaSweep).pass());
    expect(await trail(id)).toEqual(
      expect.arrayContaining([
        ['response', 1, 'stopped', 'sla_disabled'],
        ['resolution', 1, 'stopped', 'sla_disabled'],
      ]),
    );
    const count = (await slaEvents(id)).length;
    await work(id, 'start', undefined, off).expect(204);
    await rewind(id, 30 * DAY);
    await sweep();
    expect((await slaEvents(id)).length).toBe(count);
    expect(await breaches(off.c, id)).toEqual([]);
    // On again: a new cycle, from that moment.
    await enable(off);
    expect((await slaClocks(id)).filter((c) => c.cycle === 2)).toHaveLength(1);
  });

  // --- views -------------------------------------------------------------------

  it('residents see the due times and whether it is paused; dispatch also sees the states and the events', async () => {
    const id = await assigned();
    const mine = await d
      .http('get', `/tickets/${id}`, s.owner.token)
      .expect(200);
    const sla = (mine.body as { sla: Record<string, unknown> }).sla;
    expect(Object.keys(sla).sort()).toEqual([
      // ADR 0038.
      'overdue',
      'paused',
      'resolutionDueAt',
      'responseDueAt',
    ]);
    expect(sla.paused).toBe(false);
    expect(sla.overdue).toBe(false);
    const dispatch = await d
      .http('get', `/maintenance/tickets/${id}`, s.supervisor.token)
      .expect(200);
    expect(
      (dispatch.body as { sla: Record<string, unknown> }).sla,
    ).toMatchObject({ responseState: 'running', resolutionState: 'running' });
    const events = await d
      .http('get', `/maintenance/tickets/${id}/sla-events`, s.supervisor.token)
      .expect(200);
    expect(
      (events.body as { data: { kind: string }[] }).data.map((e) => e.kind),
    ).toEqual(['started', 'started']);
    // The technician's view has no SLA; the events are dispatch's.
    const tech = await d
      .http('get', `/technician/tickets/${id}`, s.techs[0].token)
      .expect(200);
    expect(tech.body).not.toHaveProperty('sla');
    await d
      .http('get', `/maintenance/tickets/${id}/sla-events`, s.techs[0].token)
      .expect(403);
  });

  // --- the projection ----------------------------------------------------------

  it('every clock in the database, rebuilt from its events, equals its projection', async () => {
    const { rebuilt, stored } = await rebuildEveryClock();
    expect(stored.length).toBeGreaterThan(0);
    expect(stored).toEqual(rebuilt);
  });
});
