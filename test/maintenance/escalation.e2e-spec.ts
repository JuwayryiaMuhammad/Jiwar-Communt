import { Client } from 'pg';
import { ResidentsService } from '../../src/community/residents/residents.service';
import { SlaSweep } from '../../src/maintenance/sla/sla-sweep';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { rewind, slaEvents } from '../setup/sla';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };

const MINUTE = 60_000;
/** A normal ticket's default targets (ADR 0034), in minutes. */
const RESPONSE = 24 * 60;
const RESOLUTION = 7 * 24 * 60;

/**
 * ADR 0038: the residents see when a ticket is overdue (a commitment late
 * and still unmet, by the database's clock, without waiting for the sweep)
 * and escalate it: once per SLA cycle, to the dispatchers and managers,
 * changing nothing else.
 */
describe('Maintenance — overdue tickets and resident escalation', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  // --- helpers ---------------------------------------------------------------

  const tech = () => s.techs[0];

  async function enableSla() {
    await d
      .http('patch', '/maintenance/sla-settings', s.manager.token, {
        slaEnabled: true,
      })
      .expect(200);
    await d.x.asManager(s.c, () => h.moduleRef.get(SlaSweep).pass());
  }

  const open = async (who: Who = s.owner, priority?: 'emergency') =>
    (
      (
        await d
          .http('post', '/tickets', who.token, {
            unitId: s.unit.id,
            categoryId: await d.categoryId(s.c, 'general'),
            description: 'Escalation fixture',
            ...(priority ? { priority } : {}),
          })
          .expect(201)
      ).body as { id: string }
    ).id;

  const assign = (id: string) =>
    d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: tech().id,
      })
      .expect(204);

  const work = (id: string, verb: string, body?: object) =>
    d
      .http('post', `/technician/tickets/${id}/${verb}`, tech().token, body)
      .expect(204);

  const escalate = (id: string, who: Who = s.owner, key?: string) => {
    const req = d.http('post', `/tickets/${id}/escalate`, who.token);
    return key ? req.set('Idempotency-Key', key) : req;
  };

  type Seen = {
    sla: { overdue: boolean; responseDueAt: string | null } | null;
    escalatedAt: string | null;
    canEscalate: boolean;
  };

  const detail = async (id: string, who: Who = s.owner) =>
    (await d.http('get', `/tickets/${id}`, who.token).expect(200)).body as Seen;

  const listed = async (id: string, who: Who = s.owner) =>
    (
      (await d.http('get', '/tickets?limit=100', who.token).expect(200))
        .body as { data: (Seen & { id: string })[] }
    ).data.find((t) => t.id === id)!;

  const escalations = (id: string) =>
    d.inTenant(s.c, (tx) =>
      tx.ticketEscalation.findMany({
        where: { ticketId: id },
        orderBy: { createdAt: 'asc' },
      }),
    );

  const notes = (id: string, kind: string) =>
    d.inTenant(s.c, (tx) =>
      tx.notification.findMany({ where: { targetId: id, kind } }),
    );

  const breaches = async (id: string) =>
    (await slaEvents(id)).filter((e) => e.kind === 'breached');

  const codeOf = (res: { body: unknown }) =>
    (res.body as { code?: string }).code;

  // --- the SLA off -----------------------------------------------------------

  it('while the compound measures no SLA, nothing is overdue and nothing is escalated', async () => {
    const id = await open();
    expect(await detail(id)).toMatchObject({
      sla: null,
      escalatedAt: null,
      canEscalate: false,
    });
    expect(codeOf(await escalate(id).expect(409))).toBe('TICKET_NOT_OVERDUE');
    expect(await escalations(id)).toEqual([]);
  });

  describe('with the SLA on', () => {
    beforeAll(() => enableSla());

    it('before the due time: not overdue, and an escalation is refused', async () => {
      const id = await open();
      for (const seen of [await detail(id), await listed(id)])
        expect(seen).toMatchObject({
          sla: { overdue: false },
          escalatedAt: null,
          canEscalate: false,
        });
      expect(codeOf(await escalate(id).expect(409))).toBe('TICKET_NOT_OVERDUE');
    });

    it('past due before the sweep ran: overdue at once; the escalation breaches the clock at its due time, tells dispatch once and changes nothing else', async () => {
      const id = await open();
      await rewind(id, RESPONSE + 1);
      // The sweep has not run: the read decides by the database's clock.
      expect(await breaches(id)).toEqual([]);
      for (const seen of [await detail(id), await listed(id)])
        expect(seen).toMatchObject({
          sla: { overdue: true },
          escalatedAt: null,
          canEscalate: true,
        });
      // The read wrote nothing.
      expect(await breaches(id)).toEqual([]);
      const before = await d.ticketRow(s.c, id);

      await escalate(id).expect(204);

      const [breach, ...more] = await breaches(id);
      expect(more).toEqual([]);
      const started = (await slaEvents(id)).find(
        (e) => e.clock === 'response' && e.kind === 'started',
      )!;
      expect(breach).toMatchObject({ clock: 'response', cycle: 1 });
      expect(breach.at.getTime()).toBe(
        started.at.getTime() + RESPONSE * MINUTE,
      );
      expect(await escalations(id)).toMatchObject([
        { slaCycle: 1, accountId: s.owner.id },
      ]);
      // The dispatchers and managers, once each, with the number only.
      const told = await notes(id, 'ticket.resident_escalated');
      expect(told.map((n) => n.accountId).sort()).toEqual(
        [s.manager.id, s.supervisor.id].sort(),
      );
      for (const n of told)
        expect(Object.keys(n.params as object)).toEqual(['ticketNumber']);
      expect(
        await d.inTenant(s.c, (tx) =>
          tx.auditLog.findMany({
            where: { action: 'ticket.escalated_by_resident', targetId: id },
          }),
        ),
      ).toMatchObject([
        {
          metadata: { slaCycle: 1, clocks: ['response'] },
          actorId: s.owner.id,
        },
      ]);
      // Nothing else moved.
      expect(await d.ticketRow(s.c, id)).toMatchObject({
        status: before.status,
        priority: before.priority,
        technicianId: before.technicianId,
      });

      // Once per cycle.
      expect(await detail(id)).toMatchObject({
        sla: { overdue: true },
        escalatedAt: expect.any(String) as string,
        canEscalate: false,
      });
      expect(codeOf(await escalate(id).expect(409))).toBe(
        'TICKET_ALREADY_ESCALATED',
      );
      expect(await escalations(id)).toHaveLength(1);
      // Dispatch reads who and when.
      const seen = await d
        .http('get', `/maintenance/tickets/${id}`, s.supervisor.token)
        .expect(200);
      expect(
        (seen.body as { escalations: object[] }).escalations,
      ).toMatchObject([{ slaCycle: 1, by: { id: s.owner.id } }]);
    });

    it('an emergency tells them critically', async () => {
      const id = await open(s.owner, 'emergency');
      await rewind(id, 61);
      await escalate(id).expect(204);
      const told = await notes(id, 'ticket.resident_escalated_emergency');
      expect(told.length).toBeGreaterThan(0);
      for (const n of told) expect(n.priority).toBe('critical');
      expect(await notes(id, 'ticket.resident_escalated')).toEqual([]);
    });

    it('overdue means still unmet: a late response that was then given, a hold for the residents, the work reported done', async () => {
      const id = await open();
      await assign(id);
      await rewind(id, RESPONSE + 1);
      expect(await detail(id)).toMatchObject({
        sla: { overdue: true },
        canEscalate: true,
      });
      // The technician starts, late: the response is breached, and met.
      await work(id, 'start');
      expect((await breaches(id)).map((e) => e.clock)).toEqual(['response']);
      expect(await detail(id)).toMatchObject({
        sla: { overdue: false },
        canEscalate: false,
      });
      expect(codeOf(await escalate(id).expect(409))).toBe('TICKET_NOT_OVERDUE');

      // Now the resolution is late.
      await rewind(id, RESOLUTION);
      expect(await detail(id)).toMatchObject({
        sla: { overdue: true },
        canEscalate: true,
      });
      // Waiting for the residents themselves: overdue, but theirs to move.
      await work(id, 'hold', { holdReason: 'awaiting_resident' });
      expect(await detail(id)).toMatchObject({
        sla: { overdue: true },
        canEscalate: false,
      });
      expect(codeOf(await escalate(id).expect(409))).toBe(
        'TICKET_INVALID_TRANSITION',
      );
      await work(id, 'resume');
      expect((await detail(id)).canEscalate).toBe(true);
      // Reported done: nobody owes the residents anything now.
      await work(id, 'complete');
      expect(await detail(id)).toMatchObject({
        sla: { overdue: false },
        canEscalate: false,
      });
      expect(codeOf(await escalate(id).expect(409))).toBe(
        'TICKET_INVALID_TRANSITION',
      );
      expect(await escalations(id)).toEqual([]);
    });

    it('a reopen starts a new SLA cycle, and may be escalated again', async () => {
      const id = await open();
      await rewind(id, RESPONSE + 1);
      await escalate(id).expect(204);
      await assign(id);
      await work(id, 'start');
      await work(id, 'complete');
      await d
        .http('post', `/tickets/${id}/confirm`, s.owner.token, { rating: 3 })
        .expect(204);
      await d
        .http('post', `/tickets/${id}/reopen`, s.owner.token, {
          reasonCode: 'problem_returned',
          reason: 'Again',
        })
        .expect(204);
      expect(await detail(id)).toMatchObject({
        sla: { overdue: false },
        escalatedAt: null,
        canEscalate: false,
      });
      await rewind(id, RESPONSE + 1);
      await escalate(id).expect(204);
      expect((await escalations(id)).map((e) => e.slaCycle)).toEqual([1, 2]);
    });

    it('two at once: one escalation, one notice each, the other is told it was already done', async () => {
      // A co-owner reports; the unit's primary sees the ticket too.
      const other = await d.x.resident(s.c, [s.unit.id]);
      const coOwner = await d.who(s.c, other.id, 'resident');
      const id = await open(coOwner);
      await rewind(id, RESPONSE + 1);
      const results = await Promise.all([
        escalate(id, coOwner),
        escalate(id, s.owner),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
      expect(codeOf(results.find((r) => r.status === 409)!)).toBe(
        'TICKET_ALREADY_ESCALATED',
      );
      expect(await escalations(id)).toHaveLength(1);
      expect(await breaches(id)).toHaveLength(1);
      const told = await notes(id, 'ticket.resident_escalated');
      expect(told).toHaveLength(new Set(told.map((n) => n.accountId)).size);
    });

    it('a retry with the same Idempotency-Key replays the answer; nothing is written twice', async () => {
      const id = await open();
      await rewind(id, RESPONSE + 1);
      const key = `escalate-${id}`;
      await escalate(id, s.owner, key).expect(204);
      const replay = await escalate(id, s.owner, key).expect(204);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.text).toBe('');
      expect(await escalations(id)).toHaveLength(1);
      expect(
        (await notes(id, 'ticket.resident_escalated')).filter(
          (n) => n.accountId === s.supervisor.id,
        ),
      ).toHaveLength(1);
    });

    it('someone who left the unit still sees their ticket, and may not escalate it', async () => {
      const other = await d.x.resident(s.c, [s.unit.id]);
      const leaving = await d.who(s.c, other.id, 'resident');
      const id = await open(leaving);
      await rewind(id, RESPONSE + 1);
      const occupancy = (await d.x.occupancies(s.c, s.unit.id)).find(
        (o) => o.accountId === leaving.id && o.status === 'active',
      )!;
      await d.x.asManager(s.c, () =>
        h.moduleRef
          .get(ResidentsService)
          .endOccupancy(occupancy.id, { code: 'moved_out', text: 'Left' }),
      );
      expect(await detail(id, leaving)).toMatchObject({
        sla: { overdue: true },
        canEscalate: false,
      });
      expect(codeOf(await escalate(id, leaving).expect(403))).toBe(
        'TICKETS_NOT_ALLOWED',
      );
      // The household still may.
      expect((await detail(id, s.owner)).canEscalate).toBe(true);
    });

    it('the list costs the same number of queries for one ticket as for many', async () => {
      const unit = await d.x.unit(s.c);
      const r = await d.x.resident(s.c, [unit.id]);
      const who = await d.who(s.c, r.id, 'resident');
      const one = async () =>
        (
          (
            await d
              .http('post', '/tickets', who.token, {
                unitId: unit.id,
                categoryId: await d.categoryId(s.c, 'general'),
                description: 'Query-count fixture',
              })
              .expect(201)
          ).body as { id: string }
        ).id;
      const queries = async () => {
        const spy = jest.spyOn(Client.prototype, 'query');
        try {
          await d.http('get', '/tickets?limit=100', who.token).expect(200);
          return spy.mock.calls.length;
        } finally {
          spy.mockRestore();
        }
      };
      const first = await one();
      await rewind(first, RESPONSE + 1);
      await escalate(first, who).expect(204);
      await queries(); // warm: the permission cache
      const single = await queries();
      for (let i = 0; i < 7; i++) await one();
      const many = await queries();
      expect(single).toBeGreaterThan(0);
      expect(many).toBe(single);
    });
  });
});
