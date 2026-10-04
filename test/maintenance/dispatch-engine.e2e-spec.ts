import {
  AccountDeletionService,
  scopePhrase,
} from '../../src/core/accounts/account-deletion.service';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0033: the dispatch engine on one ticket — who is a candidate, who is
 * chosen, and what happens when nobody can take it. These run the engine
 * through a dispatcher's "auto-assign" request, which works whether or not
 * automatic dispatch is on; the other triggers are in dispatch-triggers.
 */
describe('Dispatch engine — candidates, choice, no candidate', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
  }, 60_000);

  afterAll(() => h.close());

  type S = Awaited<ReturnType<typeof d.setUp>>;
  type Who = S['techs'][number];

  const autoAssign = (s: S, ticketId: string) =>
    d.http(
      'post',
      `/maintenance/tickets/${ticketId}/auto-assign`,
      s.supervisor.token,
    );
  const outcome = async (s: S, ticketId: string) =>
    (await autoAssign(s, ticketId).expect(200)).body as {
      outcome: string;
      technician: { id: string } | null;
    };
  /**
   * What a dispatcher's requests did (the other triggers are in
   * dispatch-triggers): a ticket's creation leaves a row of its own.
   */
  const attempts = async (s: S, ticketId: string) =>
    (
      (
        await d
          .http(
            'get',
            `/maintenance/tickets/${ticketId}/dispatch-attempts`,
            s.supervisor.token,
          )
          .expect(200)
      ).body as {
        data: {
          trigger: string;
          outcome: string;
          cycle: number;
          candidateCount: number;
          technician: { id: string } | null;
          reasonCode: string | null;
          notified: boolean;
        }[];
      }
    ).data.filter((r) => r.trigger === 'manual');
  const assign = (s: S, ticketId: string, tech: Who) =>
    d
      .http(
        'post',
        `/maintenance/tickets/${ticketId}/assign`,
        s.supervisor.token,
        {
          technicianId: tech.id,
        },
      )
      .expect(204);
  const work = (tech: Who, ticketId: string, verb: string, body?: object) =>
    d
      .http('post', `/technician/tickets/${ticketId}/${verb}`, tech.token, body)
      .expect(204);
  const notifications = (c: S['c'], accountId: string, kind: string) =>
    d.inTenant(c, (tx) =>
      tx.notification.findMany({ where: { accountId, kind } }),
    );
  const available = (s: S, ...techs: Who[]) =>
    Promise.all(techs.map((t) => d.setAvailability(s.c, t.id, 'available')));

  describe('candidates', () => {
    it('needs a specialty that can handle the category', async () => {
      const s = await d.setUp(2);
      await d.specialize(s, s.techs[0], ['electrical']);
      await d.specialize(s, s.techs[1], ['plumbing']);
      await available(s, ...s.techs);
      const ticket = await d.openTicket(s, { category: 'plumbing' });
      const result = await outcome(s, ticket);
      expect(result).toMatchObject({
        outcome: 'assigned',
        technician: { id: s.techs[1].id },
      });
      const row = await d.ticketRow(s.c, ticket);
      expect(row).toMatchObject({
        status: 'assigned',
        technicianId: s.techs[1].id,
      });
      expect(await attempts(s, ticket)).toMatchObject([
        {
          trigger: 'manual',
          outcome: 'assigned',
          candidateCount: 1,
          technician: { id: s.techs[1].id },
        },
      ]);
    });

    it('a category with no specialty can go to any available technician', async () => {
      const s = await d.setUp(1);
      const category = await d.categoryId(s.c, 'general');
      await d
        .http(
          'put',
          `/maintenance/categories/${category}/specialties`,
          s.manager.token,
          { specialtyIds: [] },
        )
        .expect(204);
      await available(s, s.techs[0]); // no specialty of their own
      const ticket = await d.openTicket(s, { category: 'general' });
      expect(await outcome(s, ticket)).toMatchObject({
        outcome: 'assigned',
        technician: { id: s.techs[0].id },
      });
    });

    it('a retired specialty counts for nobody: a category left with none is open to all', async () => {
      const s = await d.setUp(1);
      await available(s, s.techs[0]);
      const plumbing = await d.specialtyId(s.c, 'plumbing');
      const ticket = await d.openTicket(s, { category: 'plumbing' });
      // The only specialty that can handle it, and the technician has none.
      expect((await outcome(s, ticket)).outcome).toBe('no_candidate');
      await d
        .http(
          'patch',
          `/maintenance/specialties/${plumbing}`,
          s.manager.token,
          { active: false },
        )
        .expect(200);
      expect((await outcome(s, ticket)).outcome).toBe('assigned');
    });

    it('an unavailable technician, and one with no availability row, are not candidates', async () => {
      const s = await d.setUp(3);
      const category = await d.categoryId(s.c, 'general');
      await d
        .http(
          'put',
          `/maintenance/categories/${category}/specialties`,
          s.manager.token,
          { specialtyIds: [] },
        )
        .expect(204);
      await d.setAvailability(s.c, s.techs[0].id, 'unavailable');
      // techs[1]: never set. techs[2]: available.
      await available(s, s.techs[2]);
      const ticket = await d.openTicket(s);
      expect(await outcome(s, ticket)).toMatchObject({
        technician: { id: s.techs[2].id },
      });
      expect(await attempts(s, ticket)).toMatchObject([{ candidateCount: 1 }]);
    });

    it('an inactive account is not a candidate, even if its availability row says available', async () => {
      const s = await d.setUp(2);
      const category = await d.categoryId(s.c, 'general');
      await d
        .http(
          'put',
          `/maintenance/categories/${category}/specialties`,
          s.manager.token,
          { specialtyIds: [] },
        )
        .expect(204);
      await available(s, ...s.techs);
      // Straight into the account: no lifecycle hook ran to switch the row off.
      await d.inTenant(s.c, (tx) =>
        tx.account.update({
          where: { id: s.techs[0].id },
          data: { status: 'inactive' },
        }),
      );
      const ticket = await d.openTicket(s);
      expect(await outcome(s, ticket)).toMatchObject({
        technician: { id: s.techs[1].id },
      });
    });

    it('an account whose role lacks tickets.work is not a candidate', async () => {
      const s = await d.setUp(1);
      const category = await d.categoryId(s.c, 'general');
      await d
        .http(
          'put',
          `/maintenance/categories/${category}/specialties`,
          s.manager.token,
          { specialtyIds: [] },
        )
        .expect(204);
      const guard = await d.g.guard(s.c); // the default guard role
      await d.setAvailability(s.c, guard.id, 'available');
      const ticket = await d.openTicket(s);
      expect(await outcome(s, ticket)).toMatchObject({
        outcome: 'no_candidate',
      });
    });

    it('a technician who declined the ticket is never offered it again, in any cycle', async () => {
      const s = await d.setUp(2);
      const category = await d.categoryId(s.c, 'general');
      await d
        .http(
          'put',
          `/maintenance/categories/${category}/specialties`,
          s.manager.token,
          { specialtyIds: [] },
        )
        .expect(204);
      const [a, b] = s.techs;
      await available(s, a, b);
      const ticket = await d.openTicket(s);
      await assign(s, ticket, a);
      await work(a, ticket, 'decline', { reasonCode: 'unavailable' });
      expect(await outcome(s, ticket)).toMatchObject({
        technician: { id: b.id },
      });
      // Back to the queue, and into a later cycle.
      await work(b, ticket, 'decline', { reasonCode: 'unsafe' });
      await d.inTenant(s.c, (tx) =>
        tx.ticket.update({ where: { id: ticket }, data: { cycle: 2 } }),
      );
      expect(await outcome(s, ticket)).toMatchObject({
        outcome: 'no_candidate',
      });
      // A third technician is the only one left.
      const c = await d.who(
        s.c,
        (await d.g.guard(s.c, 'technician')).id,
        'staff',
      );
      await available(s, c);
      expect(await outcome(s, ticket)).toMatchObject({
        technician: { id: c.id },
      });
    });
  });

  describe('choice', () => {
    async function pool(n = 2) {
      const s = await d.setUp(n);
      const category = await d.categoryId(s.c, 'general');
      await d
        .http(
          'put',
          `/maintenance/categories/${category}/specialties`,
          s.manager.token,
          { specialtyIds: [] },
        )
        .expect(204);
      await available(s, ...s.techs);
      return s;
    }

    it('the lowest workload wins: weight of the status × multiplier of the priority', async () => {
      const s = await pool(3);
      const [a, b, c] = s.techs;
      // a: an urgent ticket in progress = 2 × 1.5 = 3
      const t1 = await d.openTicket(s, { priority: 'urgent' });
      await assign(s, t1, a);
      await work(a, t1, 'start');
      // b: one normal ticket assigned = 1
      await assign(s, await d.openTicket(s), b);
      // c: an emergency assigned = 3
      await assign(s, await d.openTicket(s, { priority: 'emergency' }), c);
      const next = await d.openTicket(s);
      expect(await outcome(s, next)).toMatchObject({
        technician: { id: b.id },
      });
      const techs = (
        (
          await d
            .http('get', '/maintenance/technicians', s.supervisor.token)
            .expect(200)
        ).body as {
          data: { id: string; workload: number; openTickets: number }[];
        }
      ).data;
      const load = (id: string) => techs.find((t) => t.id === id)!.workload;
      // b took the new one: 1 + 1.
      expect([load(a.id), load(b.id), load(c.id)]).toEqual([3, 2, 3]);
    });

    it('an on-hold ticket weighs nothing', async () => {
      const s = await pool(2);
      const [a, b] = s.techs;
      for (let i = 0; i < 3; i++) {
        const t = await d.openTicket(s, { priority: 'emergency' });
        await assign(s, t, a);
        await work(a, t, 'start');
        await work(a, t, 'hold', { holdReason: 'awaiting_parts' });
      }
      await assign(s, await d.openTicket(s), b); // b: 1
      const next = await d.openTicket(s);
      expect(await outcome(s, next)).toMatchObject({
        technician: { id: a.id },
      }); // a: 0
    });

    it('a completed ticket is no longer open work', async () => {
      const s = await pool(2);
      const [a, b] = s.techs;
      const done = await d.openTicket(s, { priority: 'emergency' });
      await assign(s, done, a);
      await work(a, done, 'start');
      await work(a, done, 'complete');
      await assign(s, await d.openTicket(s), b); // b: 1, a: 0
      expect(await outcome(s, await d.openTicket(s))).toMatchObject({
        technician: { id: a.id },
      });
    });

    it('a tie goes to whoever was given a ticket longest ago, never-assigned first', async () => {
      const s = await pool(3);
      const [a, b, c] = s.techs;
      for (const tech of [b, a]) {
        const t = await d.openTicket(s);
        await assign(s, t, tech);
        await work(tech, t, 'start');
        await work(tech, t, 'complete');
      }
      // All three carry nothing. c was never given a ticket, then b, then a.
      const first = await outcome(s, await d.openTicket(s));
      expect(first.technician!.id).toBe(c.id);
      // c now carries one; of a and b (equal), b's last assignment is older.
      const second = await outcome(s, await d.openTicket(s));
      expect(second.technician!.id).toBe(b.id);
    });

    it('a full tie goes to the lowest id', async () => {
      const s = await pool(3);
      const lowest = [...s.techs].sort((p, q) => (p.id < q.id ? -1 : 1))[0];
      expect(await outcome(s, await d.openTicket(s))).toMatchObject({
        technician: { id: lowest.id },
      });
    });

    it('uses the compound’s own weights', async () => {
      const s = await pool(2);
      const [a, b] = s.techs;
      const t = await d.openTicket(s);
      await assign(s, t, a);
      await work(a, t, 'start'); // 2 with the defaults
      await assign(s, await d.openTicket(s), b); // 1
      await assign(s, await d.openTicket(s), b); // 2
      await assign(s, await d.openTicket(s), b); // 3
      // The defaults say a (2) is lighter than b (3); a heavier in-progress flips it.
      await d
        .http('patch', '/maintenance/dispatch-settings', s.manager.token, {
          weightInProgress: 5,
        })
        .expect(200);
      expect(await outcome(s, await d.openTicket(s))).toMatchObject({
        technician: { id: b.id },
      });
    });
  });

  describe('the answer and its record', () => {
    it('writes an automatic assignment with no actor, a status row by the system, and tells the technician and the reporter', async () => {
      const s = await d.setUp(1);
      await d.specialize(s, s.techs[0], ['plumbing']);
      await available(s, s.techs[0]);
      const ticket = await d.openTicket(s, { category: 'plumbing' });
      await outcome(s, ticket);
      const [assignments, history] = await d.inTenant(s.c, (tx) =>
        Promise.all([
          tx.ticketAssignment.findMany({ where: { ticketId: ticket } }),
          tx.ticketStatusHistory.findMany({
            where: { ticketId: ticket },
            orderBy: { createdAt: 'asc' },
          }),
        ]),
      );
      expect(assignments).toMatchObject([
        {
          assignmentType: 'automatic',
          fromId: null,
          toId: s.techs[0].id,
          assignedById: null,
          cycle: 1,
        },
      ]);
      expect(history.map((r) => [r.fromStatus, r.toStatus, r.actorId])).toEqual(
        [
          [null, 'new', s.owner.id],
          ['new', 'assigned', null],
        ],
      );
      expect(
        await notifications(s.c, s.techs[0].id, 'ticket.assigned'),
      ).toHaveLength(1);
      expect(
        await notifications(s.c, s.owner.id, 'ticket.status_changed'),
      ).toHaveLength(1);
    });

    it('only a ticket in the queue: anything else is TICKET_INVALID_TRANSITION, an unknown id TICKET_NOT_FOUND', async () => {
      const s = await d.setUp(1);
      await available(s, s.techs[0]);
      const ticket = await d.openTicket(s);
      await assign(s, ticket, s.techs[0]);
      const res = await autoAssign(s, ticket).expect(409);
      expect(res.body).toMatchObject({
        code: 'TICKET_INVALID_TRANSITION',
        params: { status: 'assigned' },
      });
      expect(await attempts(s, ticket)).toEqual([]);
      const other = await d.setUp(1);
      await autoAssign(s, await d.openTicket(other)).expect(404);
    });

    it('works whether automatic dispatch is on or off, and only dispatch may ask', async () => {
      const s = await d.setUp(1);
      await available(s, s.techs[0]);
      const category = await d.categoryId(s.c, 'general');
      await d
        .http(
          'put',
          `/maintenance/categories/${category}/specialties`,
          s.manager.token,
          { specialtyIds: [] },
        )
        .expect(204);
      await d.setAutoDispatch(s.c, false);
      await d
        .http(
          'post',
          `/maintenance/tickets/${await d.openTicket(s)}/auto-assign`,
          s.techs[0].token,
        )
        .expect(403);
      expect((await outcome(s, await d.openTicket(s))).outcome).toBe(
        'assigned',
      );
    });
  });

  describe('no candidate', () => {
    it('leaves the ticket in the queue and tells the dispatchers once per cycle, however often it is retried', async () => {
      const s = await d.setUp(1); // nobody available
      const ticket = await d.openTicket(s);
      for (let i = 0; i < 3; i++)
        expect(await outcome(s, ticket)).toEqual({
          outcome: 'no_candidate',
          technician: null,
        });
      expect(await d.ticketRow(s.c, ticket)).toMatchObject({
        status: 'new',
        technicianId: null,
      });
      const rows = await attempts(s, ticket);
      expect(
        rows.map((r) => [r.outcome, r.candidateCount, r.notified]),
      ).toEqual([
        ['no_candidate', 0, true],
        ['no_candidate', 0, false],
        ['no_candidate', 0, false],
      ]);
      for (const dispatcher of [s.manager, s.supervisor])
        expect(
          await notifications(s.c, dispatcher.id, 'ticket.unassignable'),
        ).toHaveLength(1);
      // The next cycle is a new problem.
      await d.inTenant(s.c, (tx) =>
        tx.ticket.update({ where: { id: ticket }, data: { cycle: 2 } }),
      );
      await outcome(s, ticket);
      expect(
        await notifications(s.c, s.supervisor.id, 'ticket.unassignable'),
      ).toHaveLength(2);
    });

    it('is critical for an emergency', async () => {
      const s = await d.setUp(1);
      const ticket = await d.openTicket(s, { priority: 'emergency' });
      await outcome(s, ticket);
      const [row] = await notifications(
        s.c,
        s.supervisor.id,
        'ticket.unassignable_emergency',
      );
      expect(row).toMatchObject({ priority: 'critical', targetId: ticket });
      expect(
        await notifications(s.c, s.supervisor.id, 'ticket.unassignable'),
      ).toHaveLength(0);
      // Only codes, the number and the unit: never the description.
      const params = row.params as Record<string, unknown>;
      expect(Object.keys(params).sort()).toEqual([
        'categoryKey',
        'ticketNumber',
        'unitCode',
      ]);
    });

    it('a technician who becomes available later is found by the next try', async () => {
      const s = await d.setUp(1);
      const category = await d.categoryId(s.c, 'general');
      await d
        .http(
          'put',
          `/maintenance/categories/${category}/specialties`,
          s.manager.token,
          { specialtyIds: [] },
        )
        .expect(204);
      const ticket = await d.openTicket(s);
      expect((await outcome(s, ticket)).outcome).toBe('no_candidate');
      await available(s, s.techs[0]);
      expect((await outcome(s, ticket)).outcome).toBe('assigned');
      expect((await attempts(s, ticket)).map((r) => r.outcome)).toEqual([
        'no_candidate',
        'assigned',
      ]);
    });
  });

  describe('an erased technician', () => {
    it('is a pointer to the tombstone in the attempts, never a name', async () => {
      const s = await d.setUp(1);
      const category = await d.categoryId(s.c, 'general');
      await d
        .http(
          'put',
          `/maintenance/categories/${category}/specialties`,
          s.manager.token,
          { specialtyIds: [] },
        )
        .expect(204);
      const [tech] = s.techs;
      await available(s, tech);
      const ticket = await d.openTicket(s);
      await outcome(s, ticket);
      const named = (await attempts(s, ticket))[0].technician as {
        id: string;
        fullName?: string;
      };
      expect(named).toMatchObject({
        id: tech.id,
        fullName: expect.any(String) as string,
      });
      const deletion = h.moduleRef.get(AccountDeletionService);
      const request = await d.x.as(s.c, { id: tech.id, type: 'staff' }, () =>
        deletion.requestDeletion('DELETE'),
      );
      await d.inTenant(s.c, (tx) =>
        tx.accountDeletionRequest.update({
          where: { id: request.id },
          data: {
            requestedAt: new Date(Date.now() - 31 * 86_400_000),
            effectiveAt: new Date(Date.now() - 86_400_000),
          },
        }),
      );
      await d.x.asManager(s.c, () =>
        deletion.erase(request.id, scopePhrase(tech.id)),
      );
      const rows = await attempts(s, ticket);
      expect(rows[0].technician).toEqual({ id: tech.id, erased: true });
      expect(JSON.stringify(rows)).not.toContain(named.fullName!);
    });
  });

  describe('who sees it', () => {
    it('attempts and workload are dispatch-only', async () => {
      const s = await d.setUp(1);
      const ticket = await d.openTicket(s);
      await d
        .http(
          'get',
          `/maintenance/tickets/${ticket}/dispatch-attempts`,
          s.techs[0].token,
        )
        .expect(403);
      await d
        .http(
          'get',
          `/maintenance/tickets/${ticket}/dispatch-attempts`,
          s.owner.token,
        )
        .expect(403);
      await d
        .http('get', '/maintenance/technicians', s.techs[0].token)
        .expect(403);
    });
  });
});
