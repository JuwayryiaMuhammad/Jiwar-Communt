import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { newId } from '../../src/core/common/uuid';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { SLA_SWEEP, SlaSweep } from '../../src/maintenance/sla/sla-sweep';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/** Tickets already open when the manager turns the SLA on. */
const OPEN = 240;
/** Of which assigned to the technician; the rest are queued. */
const ASSIGNED = 60;
/** Queued tickets assigned over HTTP while the clocks are being started. */
const WRITTEN = 30;

/**
 * ADR 0034: turning the SLA on in a large compound. The switch is one short
 * transaction; the clocks of the open tickets start afterwards, ticket by
 * ticket, while residents and dispatch keep working on them. No clock is
 * missed, none is started twice, none is backdated, and no transaction
 * starts the clocks of more than one ticket — what keeps every lock short
 * (the same class of problem as ADR 0033's dispatch lock: Prisma gives up
 * on a transaction after 10 s). Asserted on the rows each transaction
 * wrote, not on the wall clock.
 */
describe('Maintenance — turning the SLA on in a large compound', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
  const ids: string[] = [];

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    // Straight into the table: tickets that existed before (setup, not a test).
    const categoryId = await d.categoryId(s.c, 'general');
    await d.inTenant(s.c, async (tx) => {
      for (let i = 0; i < OPEN; i++) {
        const id = newId();
        const assigned = i < ASSIGNED;
        await tx.ticket.create({
          data: {
            id,
            tenantId: s.c.tenantId,
            number: 100_000 + i,
            unitId: s.unit.id,
            categoryId,
            createdById: s.owner.id,
            reporterId: s.owner.id,
            priority: 'normal',
            description: 'Activation fixture',
            status: assigned ? 'assigned' : 'new',
            technicianId: assigned ? s.techs[0].id : null,
            assignedAt: assigned ? new Date() : null,
          },
        });
        ids.push(id);
      }
    });
  }, 120_000);

  afterAll(() => h.close());

  it('starts every open ticket’s clocks exactly once, beside concurrent writes, one ticket per transaction', async () => {
    const cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
    const on = await d
      .http('patch', '/maintenance/sla-settings', s.manager.token, {
        slaEnabled: true,
      })
      .expect(200);
    const enabledAt = new Date(
      (on.body as { enabledAt: string }).enabledAt,
    ).getTime();
    // The pass the request started runs; a second pass and the
    // dispatchers' writes run beside it.
    const writes = ids.slice(ASSIGNED, ASSIGNED + WRITTEN).map((id) =>
      d
        .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
          technicianId: s.techs[0].id,
        })
        .expect(204),
    );
    await Promise.all([
      ...writes,
      cls.run(async () => {
        cls.set('tenantId', s.c.tenantId);
        return h.moduleRef.get(SlaSweep).pass();
      }),
    ]);
    // Whatever the passes left, the sweep finishes.
    for (let i = 0; i < 5; i++)
      await h.moduleRef.get(SweepRunner).run(SLA_SWEEP, new Date());

    const clocks = await d.inTenant(s.c, (tx) =>
      tx.ticketSlaClock.findMany({ where: { ticketId: { in: ids } } }),
    );
    const starts = await d.inTenant(s.c, (tx) =>
      tx.ticketSlaEvent.findMany({
        where: { ticketId: { in: ids }, kind: 'started' },
      }),
    );
    for (const id of ids) {
      const mine = clocks.filter((c) => c.ticketId === id);
      // One cycle, both clocks: none of them had been responded to.
      expect(mine.map((c) => [c.cycle, c.clock]).sort()).toEqual([
        [1, 'resolution'],
        [1, 'response'],
      ]);
      for (const c of mine)
        expect(c.startedAt.getTime()).toBeGreaterThanOrEqual(enabledAt);
      // Exactly one `started` per clock.
      expect(
        starts
          .filter((e) => e.ticketId === id)
          .map((e) => e.clock)
          .sort(),
      ).toEqual(['resolution', 'response']);
    }
    // One ticket per transaction: the `started` events (immutable rows)
    // that one transaction wrote (one xmin) all belong to one ticket. A
    // pass that started a batch's clocks under one lock wrote them in one.
    const crowded = await d.inTenant(
      s.c,
      (tx) =>
        tx.$queryRaw<{ xmin: string; tickets: number }[]>`
          SELECT xmin::text AS xmin, count(DISTINCT ticket_id)::int AS tickets
            FROM ticket_sla_events
           WHERE ticket_id = ANY(${ids}::uuid[]) AND kind = 'started'
           GROUP BY xmin::text
          HAVING count(DISTINCT ticket_id) > 1`,
    );
    expect(crowded).toEqual([]);
  }, 120_000);

  it('a second run changes nothing', async () => {
    const before = await d.inTenant(s.c, (tx) =>
      tx.ticketSlaEvent.count({ where: { ticketId: { in: ids } } }),
    );
    await h.moduleRef.get(SweepRunner).run(SLA_SWEEP, new Date());
    const after = await d.inTenant(s.c, (tx) =>
      tx.ticketSlaEvent.count({ where: { ticketId: { in: ids } } }),
    );
    expect(after).toBe(before);
  });
});
