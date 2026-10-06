import {
  AccountDeletionService,
  scopePhrase,
} from '../../src/core/accounts/account-deletion.service';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { DispatchSweep } from '../../src/maintenance/dispatch/dispatch-sweep';
import { VISIT_LATE_SWEEP } from '../../src/maintenance/visits/visit-lifecycle';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };

const MINUTE = 60_000;

/**
 * ADR 0034: a visit ends by itself when its ticket's technician changes or
 * is released — every path of ADR 0032 and 0033 — and when the ticket is
 * cancelled, closed or its work reported done. Its consent is void and the
 * residents are told. And a confirmed visit not arrived 15 minutes after its
 * start is noticed once.
 */
describe('Maintenance — visits end with the assignment; late visits', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  let family: Who;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
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
  }, 90_000);

  afterAll(() => h.close());

  /** A fresh technician (each path takes one out of the pool). */
  const technician = async (): Promise<Who> =>
    d.who(s.c, (await d.g.guard(s.c, 'technician')).id, 'staff');

  /** A ticket in `tech`'s hands with a confirmed visit that has consent. */
  async function withVisit(tech: Who, inMinutes = 60) {
    const id = await d.openTicket(s);
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: tech.id,
      })
      .expect(204);
    const start = Date.now() + inMinutes * MINUTE;
    const proposed = await d
      .http('post', `/technician/tickets/${id}/visits`, tech.token, {
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 60 * MINUTE).toISOString(),
      })
      .expect(201);
    const visitId = (proposed.body as { id: string }).id;
    await d
      .http('post', `/tickets/${id}/visits/${visitId}/confirm`, s.owner.token)
      .expect(204);
    await d
      .http(
        'post',
        `/tickets/${id}/visits/${visitId}/absence-consent`,
        family.token,
      )
      .expect(204);
    return { id, visitId };
  }

  const visitRow = (visitId: string) =>
    d.inTenant(s.c, (tx) =>
      tx.ticketVisit.findUniqueOrThrow({ where: { id: visitId } }),
    );

  /** Cancelled by the system for `reason`, consent void, residents told. */
  async function expectEnded(
    v: { id: string; visitId: string },
    reason: string,
  ) {
    expect(await visitRow(v.visitId)).toMatchObject({
      status: 'cancelled',
      cancelledBySide: 'system',
      cancelledById: null,
      cancelReasonCode: reason,
      absenceEntryApproved: false,
      consentById: null,
    });
    const kinds = await d.inTenant(s.c, async (tx) =>
      (
        await tx.ticketVisitEvent.findMany({
          where: { visitId: v.visitId },
          orderBy: [{ at: 'asc' }, { id: 'asc' }],
        })
      ).map((e) => [e.kind, e.actorSide, e.reasonCode]),
    );
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['cancelled', 'system', reason],
        ['consent_voided', 'system', reason],
      ]),
    );
    const told = await d.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { targetId: v.id, kind: 'ticket.visit_cancelled' },
      }),
    );
    expect(told.map((n) => n.accountId)).toEqual(
      expect.arrayContaining([s.owner.id, family.id]),
    );
  }

  // --- the technician changes or is released ----------------------------------

  it('a decline ends the visit', async () => {
    const tech = await technician();
    const v = await withVisit(tech);
    await d
      .http('post', `/technician/tickets/${v.id}/decline`, tech.token, {
        reasonCode: 'unavailable',
      })
      .expect(204);
    await expectEnded(v, 'technician_changed');
  });

  it('a reassignment ends the visit', async () => {
    const tech = await technician();
    const other = await technician();
    const v = await withVisit(tech);
    await d
      .http(
        'post',
        `/maintenance/tickets/${v.id}/reassign`,
        s.supervisor.token,
        {
          technicianId: other.id,
          reasonCode: 'workload',
        },
      )
      .expect(204);
    await expectEnded(v, 'technician_changed');
    // The new technician proposes afresh; nothing carried over.
    const start = Date.now() + 90 * MINUTE;
    await d
      .http('post', `/technician/tickets/${v.id}/visits`, other.token, {
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 30 * MINUTE).toISOString(),
      })
      .expect(201);
  });

  it('a deactivation of the technician ends the visit', async () => {
    const tech = await technician();
    const v = await withVisit(tech);
    await d
      .http('patch', `/accounts/${tech.id}/status`, s.manager.token, {
        status: 'inactive',
      })
      .expect(200);
    await expectEnded(v, 'technician_changed');
  });

  it('a freeze of the technician ends the visit', async () => {
    const tech = await technician();
    const v = await withVisit(tech);
    await d.x.asManager(s.c, () =>
      h.moduleRef.get(AccountsService).freeze(tech.id, {
        code: 'phone_reassigned',
        text: 'Number reassigned',
      }),
    );
    await expectEnded(v, 'technician_changed');
  });

  it('an erasure of the technician ends the visit', async () => {
    const tech = await technician();
    const v = await withVisit(tech);
    // An active staff role blocks a deletion (ADR 0036): the account is
    // ended first, which already ends the visit; the erasure finds it so.
    await d.x.asManager(s.c, () =>
      h.moduleRef
        .get(AccountsService)
        .updateStatus(tech.id, { status: 'inactive' }),
    );
    const deletion = h.moduleRef.get(AccountDeletionService);
    const request = await d.x.as(s.c, { id: tech.id, type: 'staff' }, () =>
      deletion.requestDeletion('DELETE'),
    );
    await d.x.asManager(s.c, () =>
      d.x.prisma.tenant.accountDeletionRequest.update({
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
    await expectEnded(v, 'technician_changed');
  });

  it('losing tickets.work (a role change, then the sweep’s reconciliation) ends the visit', async () => {
    // A role of its own, so the other suites' technicians keep theirs.
    const roles = (
      (await d.http('get', '/roles', s.manager.token).expect(200)).body as {
        data: { id: string; key: string; permissions: string[] }[];
      }
    ).data;
    const guardRole = roles.find((r) => r.key === 'guard')!;
    await d
      .http('put', `/roles/${guardRole.id}/permissions`, s.manager.token, {
        permissions: [...guardRole.permissions, 'tickets.work'],
      })
      .expect(200);
    const guardTech = await d.who(s.c, (await d.g.guard(s.c)).id, 'staff');
    const viaRole = await withVisit(guardTech);
    await d
      .http('put', `/roles/${guardRole.id}/permissions`, s.manager.token, {
        permissions: guardRole.permissions,
      })
      .expect(200);
    await expectEnded(viaRole, 'technician_changed');

    // As after `access:sync` (no handler in that process): the permission
    // goes in the table, and the dispatch sweep's reconciliation releases.
    await d
      .http('put', `/roles/${guardRole.id}/permissions`, s.manager.token, {
        permissions: [...guardRole.permissions, 'tickets.work'],
      })
      .expect(200);
    const synced = await withVisit(guardTech);
    await d.inTenant(s.c, (tx) =>
      tx.rolePermission.deleteMany({
        where: { roleId: guardRole.id, permission: 'tickets.work' },
      }),
    );
    await h.moduleRef.get(DispatchSweep).run();
    await expectEnded(synced, 'technician_changed');
  });

  // --- the ticket ends ---------------------------------------------------------

  it('a cancelled ticket ends its visit', async () => {
    const v = await withVisit(s.techs[0]);
    await d
      .http('post', `/maintenance/tickets/${v.id}/cancel`, s.supervisor.token, {
        reasonCode: 'duplicate',
      })
      .expect(204);
    await expectEnded(v, 'ticket_cancelled');
  });

  it('reporting the work done ends a pending visit and closes one at the door', async () => {
    const tech = s.techs[0];
    const pending = await withVisit(tech);
    await d
      .http('post', `/technician/tickets/${pending.id}/start`, tech.token)
      .expect(204);
    await d
      .http('post', `/technician/tickets/${pending.id}/complete`, tech.token)
      .expect(204);
    await expectEnded(pending, 'ticket_completed');

    const atDoor = await withVisit(tech, 20);
    await d
      .http(
        'post',
        `/technician/tickets/${atDoor.id}/visits/${atDoor.visitId}/arrive`,
        tech.token,
      )
      .expect(200);
    await d
      .http('post', `/technician/tickets/${atDoor.id}/complete`, tech.token)
      .expect(204);
    expect(await visitRow(atDoor.visitId)).toMatchObject({
      status: 'done',
      // At the door, the consent was used: it stays on the record.
      absenceEntryApproved: true,
    });
    // Closing changes nothing more: no active visit is left.
    await d
      .http('post', `/tickets/${atDoor.id}/confirm`, s.owner.token, {
        rating: 5,
      })
      .expect(204);
    expect((await visitRow(atDoor.visitId)).status).toBe('done');
  });

  // --- late ---------------------------------------------------------------------

  it('a confirmed visit not arrived 15 minutes after its start is noticed once, to the residents and dispatch', async () => {
    const v = await withVisit(s.techs[0], 20);
    const sweep = h.moduleRef.get(SweepRunner);
    // 30 minutes from now: started 10 minutes ago — not late yet.
    await sweep.run(VISIT_LATE_SWEEP, new Date(Date.now() + 30 * MINUTE));
    expect((await visitRow(v.visitId)).lateNotifiedAt).toBeNull();
    const later = new Date(Date.now() + 40 * MINUTE);
    await sweep.run(VISIT_LATE_SWEEP, later);
    await sweep.run(VISIT_LATE_SWEEP, later);
    await sweep.run(VISIT_LATE_SWEEP, new Date(Date.now() + 90 * MINUTE));
    expect((await visitRow(v.visitId)).lateNotifiedAt).not.toBeNull();
    const told = await d.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { targetId: v.id, kind: 'ticket.visit_late' },
      }),
    );
    const to = told.map((n) => n.accountId);
    expect(new Set(to).size).toBe(to.length);
    expect(to).toEqual(
      expect.arrayContaining([
        s.owner.id,
        family.id,
        s.supervisor.id,
        s.manager.id,
      ]),
    );
    for (const n of told)
      expect(Object.keys(n.params as object).sort()).toEqual([
        'endsAt',
        'startsAt',
        'ticketNumber',
      ]);
    const events = await d.inTenant(s.c, (tx) =>
      tx.ticketVisitEvent.count({
        where: { visitId: v.visitId, kind: 'late_notified' },
      }),
    );
    expect(events).toBe(1);
  });

  it('an arrived visit is never late', async () => {
    const tech = s.techs[0];
    const v = await withVisit(tech, 20);
    await d
      .http(
        'post',
        `/technician/tickets/${v.id}/visits/${v.visitId}/arrive`,
        tech.token,
      )
      .expect(200);
    await h.moduleRef
      .get(SweepRunner)
      .run(VISIT_LATE_SWEEP, new Date(Date.now() + 60 * MINUTE));
    expect((await visitRow(v.visitId)).lateNotifiedAt).toBeNull();
  });
});
