import { Client } from 'pg';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { DispatchEngine } from '../../src/maintenance/dispatch/dispatch-engine';
import { TicketNotices } from '../../src/maintenance/tickets/ticket-notices';
import {
  DISPATCH_SWEEP,
  DispatchSweep,
} from '../../src/maintenance/dispatch/dispatch-sweep';
import { QUEUE_BATCH } from '../../src/maintenance/dispatch/dispatch-engine';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { required } from '../setup/test-env';

/**
 * ADR 0033: what makes the engine run — a creation (both paths), a decline,
 * a technician becoming available, the sweep, a technician who can no longer
 * work — and what does not: an escalation, or automatic dispatch being off.
 */
describe('Dispatch engine — triggers', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let db: Client;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
  }, 60_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  type S = Awaited<ReturnType<typeof d.setUp>>;
  type Who = S['techs'][number];

  /** A compound with automatic dispatch on, the general category open to all. */
  async function pool(n = 2, auto = true) {
    const s = await d.setUp(n);
    const category = await d.categoryId(s.c, 'general');
    await d
      .http(
        'put',
        `/maintenance/categories/${category}/specialties`,
        s.manager.token,
        {
          specialtyIds: [],
        },
      )
      .expect(204);
    if (auto) await d.setAutoDispatch(s.c, true);
    return s;
  }
  const available = (s: S, ...techs: Who[]) =>
    Promise.all(techs.map((t) => d.setAvailability(s.c, t.id, 'available')));
  const attempts = (s: S, ticketId: string) =>
    d.inTenant(s.c, (tx) =>
      tx.ticketDispatchAttempt.findMany({
        where: { ticketId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  const trail = (s: S, ticketId: string) =>
    d.inTenant(s.c, (tx) =>
      tx.ticketAssignment.findMany({
        where: { ticketId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  const work = (tech: Who, ticketId: string, verb: string, body?: object) =>
    d.http('post', `/technician/tickets/${ticketId}/${verb}`, tech.token, body);
  const sweep = () => h.moduleRef.get(DispatchSweep).run();
  const notifications = (s: S, accountId: string, kind: string) =>
    d.inTenant(s.c, (tx) =>
      tx.notification.findMany({ where: { accountId, kind } }),
    );

  describe('a ticket is created', () => {
    it('is assigned at once to the best technician; the response shows it', async () => {
      const s = await pool(1);
      await d.specialize(s, s.techs[0], ['plumbing']);
      await available(s, s.techs[0]);
      const res = await d
        .http('post', '/tickets', s.owner.token, {
          unitId: s.unit.id,
          categoryId: await d.categoryId(s.c, 'plumbing'),
          description: 'Leak',
        })
        .expect(201);
      expect(res.body).toMatchObject({ status: 'assigned' });
      const id = (res.body as { id: string }).id;
      expect(await d.ticketRow(s.c, id)).toMatchObject({
        status: 'assigned',
        technicianId: s.techs[0].id,
      });
      expect(await trail(s, id)).toMatchObject([
        {
          assignmentType: 'automatic',
          toId: s.techs[0].id,
          assignedById: null,
        },
      ]);
      expect(await attempts(s, id)).toMatchObject([
        { trigger: 'created', outcome: 'assigned', candidateCount: 1 },
      ]);
    });

    it('a dispatcher opening a ticket for a resident triggers it too', async () => {
      const s = await pool(1);
      await available(s, s.techs[0]);
      const res = await d
        .http('post', '/maintenance/tickets', s.supervisor.token, {
          unitId: s.unit.id,
          categoryId: await d.categoryId(s.c, 'general'),
          description: 'On behalf',
          reporterAccountId: s.owner.id,
        })
        .expect(201);
      expect(res.body).toMatchObject({ status: 'assigned' });
      expect(await trail(s, (res.body as { id: string }).id)).toMatchObject([
        { assignmentType: 'automatic', toId: s.techs[0].id },
      ]);
    });

    it('with nobody available it stays queued, an emergency still tells the dispatchers, and the unassignable notice follows', async () => {
      const s = await pool(1);
      const id = await d.openTicket(s, { priority: 'emergency' });
      expect(await d.ticketRow(s.c, id)).toMatchObject({ status: 'new' });
      expect(
        await notifications(s, s.supervisor.id, 'ticket.emergency'),
      ).toHaveLength(1);
      expect(
        await notifications(
          s,
          s.supervisor.id,
          'ticket.unassignable_emergency',
        ),
      ).toHaveLength(1);
      expect(await attempts(s, id)).toMatchObject([
        { trigger: 'created', outcome: 'no_candidate', notified: true },
      ]);
    });

    it('with automatic dispatch off nothing is automatic: a skipped row, and manual assignment still works', async () => {
      const s = await pool(1, false);
      await available(s, s.techs[0]);
      const id = await d.openTicket(s);
      expect(await d.ticketRow(s.c, id)).toMatchObject({
        status: 'new',
        technicianId: null,
      });
      expect(await attempts(s, id)).toMatchObject([
        {
          trigger: 'created',
          outcome: 'skipped',
          reasonCode: 'auto_dispatch_disabled',
          candidateCount: 0,
        },
      ]);
      expect(
        await notifications(s, s.supervisor.id, 'ticket.unassignable'),
      ).toHaveLength(0);
      await d
        .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
          technicianId: s.techs[0].id,
        })
        .expect(204);
      expect(await trail(s, id)).toMatchObject([{ assignmentType: 'manual' }]);
    });

    it('a failing engine never costs the resident their ticket', async () => {
      const s = await pool(1);
      await available(s, s.techs[0]);
      const engine = h.moduleRef.get(DispatchEngine);
      const spy = jest
        .spyOn(engine, 'run')
        .mockRejectedValueOnce(new Error('boom'));
      try {
        const res = await d
          .http('post', '/tickets', s.owner.token, {
            unitId: s.unit.id,
            categoryId: await d.categoryId(s.c, 'general'),
            description: 'Engine down',
          })
          .expect(201);
        const id = (res.body as { id: string }).id;
        expect(res.body).toMatchObject({ status: 'new' });
        expect(await d.ticketRow(s.c, id)).toMatchObject({ status: 'new' });
        // The engine's own writes were rolled back with the failure.
        expect(await attempts(s, id)).toEqual([]);
        // And the sweep picks it up.
        await sweep();
        expect(await d.ticketRow(s.c, id)).toMatchObject({
          status: 'assigned',
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('a database error inside the engine', () => {
    it('aborts only its own writes: the ticket, its number and the response stand', async () => {
      const s = await pool(1);
      await available(s, s.techs[0]);
      // The assignment is written, then the notice fails with a real SQL error.
      const spy = jest
        .spyOn(h.moduleRef.get(TicketNotices), 'assigned')
        .mockImplementationOnce(async (tx) => {
          await tx.$queryRaw`SELECT 1 / 0`;
        });
      try {
        const id = await d.openTicket(s);
        expect(await d.ticketRow(s.c, id)).toMatchObject({
          status: 'new',
          technicianId: null,
          number: 1,
        });
        expect(await trail(s, id)).toEqual([]);
        expect(await attempts(s, id)).toEqual([]);
        // The transaction is healthy afterwards: the next ticket is assigned.
        const next = await d.openTicket(s);
        expect(await d.ticketRow(s.c, next)).toMatchObject({
          status: 'assigned',
          number: 2,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('a technician declines', () => {
    it('the next candidate gets it at once, and never the decliner', async () => {
      const s = await pool(2);
      const [a, b] = s.techs;
      const id = await d.openTicket(s); // nobody available yet
      await available(s, a);
      await d
        .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
          technicianId: a.id,
        })
        .expect(204);
      await available(s, b);
      await work(a, id, 'decline', { reasonCode: 'unavailable' }).expect(204);
      expect(await d.ticketRow(s.c, id)).toMatchObject({
        status: 'assigned',
        technicianId: b.id,
      });
      expect(
        (await trail(s, id)).map((r) => [r.assignmentType, r.toId ?? r.fromId]),
      ).toEqual([
        ['manual', a.id],
        ['declined', a.id],
        ['automatic', b.id],
      ]);
      expect((await attempts(s, id)).at(-1)).toMatchObject({
        trigger: 'declined',
        outcome: 'assigned',
      });
    });

    it('with nobody else it stays queued and the dispatchers hear once (the decline itself is told separately)', async () => {
      const s = await pool(1);
      const [a] = s.techs;
      await available(s, a);
      const id = await d.openTicket(s); // assigned to a on creation
      expect(await d.ticketRow(s.c, id)).toMatchObject({ technicianId: a.id });
      await work(a, id, 'decline', { reasonCode: 'unsafe' }).expect(204);
      expect(await d.ticketRow(s.c, id)).toMatchObject({
        status: 'new',
        technicianId: null,
      });
      expect(
        await notifications(s, s.supervisor.id, 'ticket.declined'),
      ).toHaveLength(1);
      expect(
        await notifications(s, s.supervisor.id, 'ticket.unassignable'),
      ).toHaveLength(1);
      await sweep();
      await sweep();
      expect(
        await notifications(s, s.supervisor.id, 'ticket.unassignable'),
      ).toHaveLength(1);
    });
  });

  describe('a technician becomes available', () => {
    it('takes the queue in order: emergency, urgent, normal, oldest first', async () => {
      const s = await pool(1);
      const normalOld = await d.openTicket(s);
      const urgent = await d.openTicket(s, { priority: 'urgent' });
      const normalNew = await d.openTicket(s);
      const emergency = await d.openTicket(s, { priority: 'emergency' });
      const [a] = s.techs;
      await d
        .http('post', '/technician/availability', a.token, {
          state: 'available',
        })
        .expect(200);
      const order = (
        await d.inTenant(s.c, (tx) =>
          tx.ticketAssignment.findMany({
            where: { assignmentType: 'automatic' },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          }),
        )
      ).map((r) => r.ticketId);
      expect(order).toEqual([emergency, urgent, normalOld, normalNew]);
      const rows = await attempts(s, emergency);
      expect(rows.at(-1)).toMatchObject({
        trigger: 'available',
        outcome: 'assigned',
      });
    });

    it('a dispatcher making them available does the same, with a reason', async () => {
      const s = await pool(1);
      const id = await d.openTicket(s);
      await d
        .http(
          'post',
          `/maintenance/technicians/${s.techs[0].id}/availability`,
          s.supervisor.token,
          {
            state: 'available',
            reasonCode: 'training',
          },
        )
        .expect(200);
      expect(await d.ticketRow(s.c, id)).toMatchObject({
        technicianId: s.techs[0].id,
      });
    });

    it('only tickets they can take: their specialties, and never one they declined', async () => {
      const s = await pool(1);
      const [a] = s.techs;
      await d.specialize(s, a, ['electrical']);
      const plumbing = await d.openTicket(s, { category: 'plumbing' });
      const electrical = await d.openTicket(s, { category: 'electrical' });
      const declined = await d.openTicket(s, { category: 'electrical' });
      // a declines one of them earlier.
      await d.setAvailability(s.c, a.id, 'available');
      await d
        .http(
          'post',
          `/maintenance/tickets/${declined}/assign`,
          s.supervisor.token,
          { technicianId: a.id },
        )
        .expect(204);
      await work(a, declined, 'decline', { reasonCode: 'other' }).expect(204);
      await d.setAvailability(s.c, a.id, 'unavailable');
      await d
        .http('post', '/technician/availability', a.token, {
          state: 'available',
        })
        .expect(200);
      expect(await d.ticketRow(s.c, electrical)).toMatchObject({
        technicianId: a.id,
      });
      expect(await d.ticketRow(s.c, plumbing)).toMatchObject({ status: 'new' });
      expect(await d.ticketRow(s.c, declined)).toMatchObject({ status: 'new' });
    });

    it('the least loaded candidate wins, so the returner does not take everything', async () => {
      const s = await pool(2);
      const [a, b] = s.techs;
      const ids = [];
      for (let i = 0; i < 4; i++) ids.push(await d.openTicket(s));
      // Both are available, but no event has told the engine yet.
      await d.setAvailability(s.c, a.id, 'available');
      await d
        .http('post', '/technician/availability', b.token, {
          state: 'available',
        })
        .expect(200);
      const rows = await Promise.all(ids.map((id) => d.ticketRow(s.c, id)));
      expect(rows.map((r) => r.technicianId).sort()).toEqual(
        [a.id, a.id, b.id, b.id].sort(),
      );
    });

    it('is bounded: the rest waits for the sweep', async () => {
      const s = await pool(1);
      const total = QUEUE_BATCH + 3;
      const ids: string[] = [];
      for (let i = 0; i < total; i++) ids.push(await d.openTicket(s));
      await d
        .http('post', '/technician/availability', s.techs[0].token, {
          state: 'available',
        })
        .expect(200);
      const queued = async () =>
        (await Promise.all(ids.map((id) => d.ticketRow(s.c, id)))).filter(
          (r) => r.status === 'new',
        ).length;
      expect(await queued()).toBe(3);
      await sweep();
      expect(await queued()).toBe(0);
    });

    it('does nothing while automatic dispatch is off', async () => {
      const s = await pool(1, false);
      const id = await d.openTicket(s);
      await d
        .http('post', '/technician/availability', s.techs[0].token, {
          state: 'available',
        })
        .expect(200);
      expect(await d.ticketRow(s.c, id)).toMatchObject({ status: 'new' });
    });
  });

  describe('the sweep', () => {
    it('retries the queue as a backstop, emergencies first', async () => {
      const s = await pool(1);
      const normal = await d.openTicket(s);
      const emergency = await d.openTicket(s, { priority: 'emergency' });
      // Available, with no event: only the sweep notices.
      await available(s, s.techs[0]);
      await sweep();
      const order = (
        await d.inTenant(s.c, (tx) =>
          tx.ticketAssignment.findMany({
            where: { assignmentType: 'automatic' },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          }),
        )
      ).map((r) => r.ticketId);
      expect(order).toEqual([emergency, normal]);
      expect((await attempts(s, normal)).at(-1)).toMatchObject({
        trigger: 'sweep',
        outcome: 'assigned',
      });
    });

    it('never repeats the unassignable notice, however many times it retries, and records each try', async () => {
      const s = await pool(1);
      const id = await d.openTicket(s);
      for (let i = 0; i < 3; i++) await sweep();
      expect(
        (await attempts(s, id)).map((r) => [r.trigger, r.outcome, r.notified]),
      ).toEqual([
        ['created', 'no_candidate', true],
        ['sweep', 'no_candidate', false],
        ['sweep', 'no_candidate', false],
        ['sweep', 'no_candidate', false],
      ]);
      expect(
        await notifications(s, s.supervisor.id, 'ticket.unassignable'),
      ).toHaveLength(1);
    });

    it('skips a compound with automatic dispatch off, and a suspended one', async () => {
      const off = await pool(1, false);
      const idOff = await d.openTicket(off);
      await available(off, off.techs[0]);
      const suspended = await pool(1);
      const idSuspended = await d.openTicket(suspended);
      await available(suspended, suspended.techs[0]);
      await h.suspendTenant(suspended.c.tenantId);
      await sweep();
      expect(await d.ticketRow(off.c, idOff)).toMatchObject({ status: 'new' });
      expect(await d.ticketRow(suspended.c, idSuspended)).toMatchObject({
        status: 'new',
      });
      // The same tickets are untouched by the sweep: no attempt row either.
      expect((await attempts(off, idOff)).map((r) => r.trigger)).toEqual([
        'created',
      ]);
      expect(
        (await attempts(suspended, idSuspended)).map((r) => r.trigger),
      ).toEqual(['created']);
    });

    /**
     * The registration itself, not a run: `runAll` goes through every
     * sweep of every domain over every compound the earlier suites left in
     * the database, so its cost grows with the whole test run (it timed
     * out once the run was long enough). The runner's registry says the
     * task is there; a stand-in for the sweep says the registered task is
     * this sweep, without touching a compound.
     */
    it('is registered with the sweep runner', async () => {
      const runner = h.moduleRef.get(SweepRunner);
      expect(() => runner.intervalOf(DISPATCH_SWEEP)).not.toThrow();
      const run = jest
        .spyOn(h.moduleRef.get(DispatchSweep), 'run')
        .mockResolvedValue(7);
      try {
        expect(await runner.run(DISPATCH_SWEEP)).toBe(7);
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        run.mockRestore();
      }
    });
  });

  describe('an escalation is not the engine’s', () => {
    async function twoRejections(s: S, tech: Who, how: 'reject' | 'reopen') {
      const id = await d.openTicket(s);
      await d
        .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
          technicianId: tech.id,
        })
        .expect(204);
      const finish = async () => {
        await work(tech, id, 'start').expect(204);
        await work(tech, id, 'complete').expect(204);
      };
      await finish();
      await d
        .http('post', `/tickets/${id}/reject`, s.owner.token, {
          reasonCode: 'not_fixed',
          reason: 'Still broken',
        })
        .expect(204);
      // The first goes back to the same technician.
      expect(await d.ticketRow(s.c, id)).toMatchObject({
        status: 'assigned',
        technicianId: tech.id,
      });
      await finish();
      if (how === 'reject')
        await d
          .http('post', `/tickets/${id}/reject`, s.owner.token, {
            reasonCode: 'not_fixed',
            reason: 'Again',
          })
          .expect(204);
      else {
        await d
          .http('post', `/tickets/${id}/confirm`, s.owner.token, { rating: 3 })
          .expect(204);
        await d
          .http('post', `/tickets/${id}/reopen`, s.owner.token, {
            reasonCode: 'not_fixed',
            reason: 'Back',
          })
          .expect(204);
      }
      return id;
    }

    it.each(['reject', 'reopen'] as const)(
      'a second %s goes back to the dispatchers even with a candidate available',
      async (how) => {
        const s = await pool(2);
        await available(s, ...s.techs);
        await d.setAutoDispatch(s.c, false);
        const id = await twoRejections(s, s.techs[0], how);
        await d.setAutoDispatch(s.c, true);
        // Escalated: in the queue, no technician, nothing automatic, and no
        // attempt but the (skipped) one the creation left.
        expect(await d.ticketRow(s.c, id)).toMatchObject({
          status: 'new',
          technicianId: null,
        });
        expect((await trail(s, id)).map((r) => r.assignmentType)).toEqual([
          'manual',
          'released',
        ]);
        expect((await attempts(s, id)).map((r) => r.trigger)).toEqual([
          'created',
        ]);
        expect(
          await notifications(s, s.supervisor.id, 'ticket.escalated'),
        ).toHaveLength(1);
        // The engine runs only when asked (the sweep, a dispatcher).
        await sweep();
        expect(await d.ticketRow(s.c, id)).toMatchObject({
          status: 'assigned',
        });
      },
    );
  });

  describe('a technician who can no longer work', () => {
    it('deactivation: the tickets in hand go to someone else at once, after the commit', async () => {
      const s = await pool(2);
      const [a, b] = s.techs;
      await available(s, a);
      const ids = [
        await d.openTicket(s),
        await d.openTicket(s, { priority: 'emergency' }),
      ];
      expect(
        (await Promise.all(ids.map((id) => d.ticketRow(s.c, id)))).map(
          (r) => r.technicianId,
        ),
      ).toEqual([a.id, a.id]);
      await available(s, b);
      await d.x.asManager(s.c, () =>
        h.moduleRef
          .get(AccountsService)
          .updateStatus(a.id, { status: 'inactive' }),
      );
      for (const id of ids) {
        expect(await d.ticketRow(s.c, id)).toMatchObject({
          status: 'assigned',
          technicianId: b.id,
        });
        expect((await trail(s, id)).map((r) => r.assignmentType)).toEqual([
          'automatic',
          'released',
          'automatic',
        ]);
        expect((await attempts(s, id)).at(-1)).toMatchObject({
          trigger: 'released',
          outcome: 'assigned',
        });
      }
    });

    it('a freeze does the same', async () => {
      const s = await pool(2);
      const [a, b] = s.techs;
      await available(s, a);
      const id = await d.openTicket(s);
      await available(s, b);
      await d.x.asManager(s.c, () =>
        h.moduleRef
          .get(AccountsService)
          .freeze(a.id, { code: 'phone_reassigned', text: 'Test' }),
      );
      expect(await d.ticketRow(s.c, id)).toMatchObject({
        status: 'assigned',
        technicianId: b.id,
      });
    });

    it('with nobody to take them they wait in the queue, and the dispatchers are told', async () => {
      const s = await pool(1);
      const [a] = s.techs;
      await available(s, a);
      const id = await d.openTicket(s);
      await d.x.asManager(s.c, () =>
        h.moduleRef
          .get(AccountsService)
          .updateStatus(a.id, { status: 'inactive' }),
      );
      expect(await d.ticketRow(s.c, id)).toMatchObject({
        status: 'new',
        technicianId: null,
      });
      expect(
        await notifications(
          s,
          s.supervisor.id,
          'ticket.technician_unavailable',
        ),
      ).toHaveLength(1);
      expect(
        await notifications(s, s.supervisor.id, 'ticket.unassignable'),
      ).toHaveLength(1);
    });

    it('a first rejection whose technician cannot take it back goes to someone else', async () => {
      const s = await pool(2);
      const [a, b] = s.techs;
      await available(s, a);
      const id = await d.openTicket(s);
      await work(a, id, 'start').expect(204);
      await work(a, id, 'complete').expect(204);
      await available(s, b);
      // a is gone (straight into the row, as the guard would have refused them).
      await d.inTenant(s.c, (tx) =>
        tx.account.update({
          where: { id: a.id },
          data: { status: 'inactive' },
        }),
      );
      await d
        .http('post', `/tickets/${id}/reject`, s.owner.token, {
          reasonCode: 'not_fixed',
          reason: 'No',
        })
        .expect(204);
      expect(await d.ticketRow(s.c, id)).toMatchObject({
        status: 'assigned',
        technicianId: b.id,
      });
      expect((await attempts(s, id)).at(-1)).toMatchObject({
        trigger: 'released',
        outcome: 'assigned',
      });
    });
  });

  describe('concurrency', () => {
    it('two tickets created at once with two equal technicians: one each', async () => {
      const s = await pool(2);
      await available(s, ...s.techs);
      for (let round = 0; round < 5; round++) {
        const created = await Promise.all([d.openTicket(s), d.openTicket(s)]);
        const rows = await Promise.all(
          created.map((id) => d.ticketRow(s.c, id)),
        );
        expect(new Set(rows.map((r) => r.technicianId)).size).toBe(2);
      }
    });

    it('the engine run twice at once on one ticket assigns once', async () => {
      const s = await pool(2);
      for (let i = 0; i < 5; i++) {
        const id = await d.openTicket(s); // nobody available: queued
        await available(s, ...s.techs);
        const results = await Promise.all([
          d.http(
            'post',
            `/maintenance/tickets/${id}/auto-assign`,
            s.supervisor.token,
          ),
          d.http(
            'post',
            `/maintenance/tickets/${id}/auto-assign`,
            s.manager.token,
          ),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(
          (await trail(s, id)).filter((r) => r.assignmentType === 'automatic'),
        ).toHaveLength(1);
        await d.setAvailability(s.c, s.techs[0].id, 'unavailable');
        await d.setAvailability(s.c, s.techs[1].id, 'unavailable');
      }
    });

    it('the sweep, a decline and a creation together: no deadlock, no double assignment', async () => {
      const s = await pool(3);
      await available(s, ...s.techs);
      for (let round = 0; round < 4; round++) {
        const held = await d.openTicket(s);
        const holder = (await d.ticketRow(s.c, held)).technicianId!;
        const tech = s.techs.find((t) => t.id === holder)!;
        const results = await Promise.all([
          work(tech, held, 'decline', { reasonCode: 'other' }),
          sweep(),
          d.http('post', '/tickets', s.owner.token, {
            unitId: s.unit.id,
            categoryId: await d.categoryId(s.c, 'general'),
            description: 'Together',
          }),
        ]);
        expect((results[0] as { status: number }).status).toBe(204);
        expect((results[2] as { status: number }).status).toBe(201);
        const row = await d.ticketRow(s.c, held);
        expect(row.technicianId).not.toBe(holder);
        const automatic = (await trail(s, held)).filter(
          (r) => r.assignmentType === 'automatic',
        );
        expect(automatic.length).toBeLessThanOrEqual(2);
      }
    });

    it('decisions in a compound wait for each other: a held dispatch lock holds a creation', async () => {
      const s = await pool(1);
      await available(s, s.techs[0]);
      const holder = new Client({
        connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
      });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        s.c.tenantId,
      ]);
      await holder.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('maintenance.dispatch:' || current_setting('app.tenant_id'), 0))`,
      );
      let id: string | undefined;
      const created = d.openTicket(s).then((v) => (id = v));
      try {
        for (let i = 0; i < 100; i++) {
          const waiting = await db.query(
            `SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype = 'advisory'`,
          );
          if ((waiting.rows[0] as { n: number }).n > 0) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(id).toBeUndefined();
      } finally {
        await holder.query('COMMIT');
        await holder.end();
      }
      await created;
      expect(await d.ticketRow(s.c, id!)).toMatchObject({ status: 'assigned' });
    });
  });
});
