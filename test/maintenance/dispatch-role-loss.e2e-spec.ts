import {
  CODE_ACCESS_CATALOG,
  type AccessCatalog,
} from '../../src/core/access/access-catalog';
import { RoleLifecycle } from '../../src/core/access/role-lifecycle';
import { PERMISSIONS } from '../../src/core/access/permissions';
import { AUDIT_ACTIONS } from '../../src/core/audit/actions';
import { AuditService } from '../../src/core/audit/audit.service';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { PermissionSyncService } from '../../src/core/platform/permission-sync.service';
import { DispatchSweep } from '../../src/maintenance/dispatch/dispatch-sweep';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0033 closes the gap ADR 0032 left open: a technician whose role loses
 * `tickets.work` keeps nothing in their hands. The ways a role's permissions
 * change are `PUT /roles/:id/permissions` and `access:sync`; an account never
 * changes role after it is created, so those are the only two.
 */
describe('Dispatch — a role loses tickets.work', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;

  /** Makes a last handler of the role hook fail, after maintenance's own. */
  let failing = false;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    h.moduleRef
      .get(RoleLifecycle)
      .onPermissionsChanged(() =>
        failing ? Promise.reject(new Error('boom')) : Promise.resolve(),
      );
    expect(AUDIT_ACTIONS['role.permissions_replaced']).toBeDefined();
  }, 60_000);

  afterAll(() => h.close());

  type S = Awaited<ReturnType<typeof d.setUp>>;

  /**
   * A technician `holder` (the `technician` role) with tickets in every open
   * status and a completed one, and a `rescuer` whose role is the guard role,
   * which is given tickets.work first: someone who keeps working when the
   * technician role loses it. Automatic dispatch is on.
   */
  async function scenario() {
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
    const roles = await roleIds(s);
    const guardRole = await d
      .http('get', `/roles/${roles.guard}`, s.manager.token)
      .expect(200);
    await d
      .http('put', `/roles/${roles.guard}/permissions`, s.manager.token, {
        permissions: [
          ...(guardRole.body as { permissions: string[] }).permissions,
          'tickets.work',
        ],
      })
      .expect(200);
    const rescuer = await d.who(s.c, (await d.g.guard(s.c)).id, 'staff');
    const [holder] = s.techs;
    const ids: Record<string, string> = {};
    await d.setAvailability(s.c, holder.id, 'available');
    await d.setAutoDispatch(s.c, true);
    for (const status of ['assigned', 'in_progress', 'on_hold', 'completed']) {
      const id = await d.openTicket(s);
      ids[status] = id;
      expect((await d.ticketRow(s.c, id)).technicianId).toBe(holder.id);
      if (status !== 'assigned') await work(holder, id, 'start');
      if (status === 'on_hold')
        await work(holder, id, 'hold', { holdReason: 'awaiting_parts' });
      if (status === 'completed') await work(holder, id, 'complete');
    }
    await d.setAvailability(s.c, rescuer.id, 'available');
    return { s, holder, rescuer, ids, roles };
  }

  const work = (
    tech: { token: string },
    id: string,
    verb: string,
    body?: object,
  ) =>
    d
      .http('post', `/technician/tickets/${id}/${verb}`, tech.token, body)
      .expect(204);
  async function roleIds(s: S) {
    const list = (
      (await d.http('get', '/roles', s.manager.token).expect(200)).body as {
        data: { id: string; key: string; permissions: string[] }[];
      }
    ).data;
    const by = (key: string) => list.find((r) => r.key === key)!;
    return {
      technician: by('technician').id,
      guard: by('guard').id,
      technicianPermissions: by('technician').permissions,
    };
  }
  const putPermissions = (s: S, roleId: string, permissions: string[]) =>
    d.http('put', `/roles/${roleId}/permissions`, s.manager.token, {
      permissions,
    });
  const row = (s: S, id: string) => d.ticketRow(s.c, id);
  const notifications = (s: S, accountId: string, kind: string) =>
    d.inTenant(s.c, (tx) =>
      tx.notification.findMany({ where: { accountId, kind } }),
    );

  describe('PUT /roles/:id/permissions', () => {
    it('releases the tickets in hand, tells the dispatchers, and the engine hands them to someone who still can', async () => {
      const { s, holder, rescuer, ids, roles } = await scenario();
      await putPermissions(
        s,
        roles.technician,
        roles.technicianPermissions.filter((p) => p !== 'tickets.work'),
      ).expect(200);
      for (const status of ['assigned', 'in_progress', 'on_hold'])
        expect(await row(s, ids[status])).toMatchObject({
          status: 'assigned',
          technicianId: rescuer.id,
        });
      // Done work keeps its technician.
      expect(await row(s, ids.completed)).toMatchObject({
        status: 'completed',
        technicianId: holder.id,
      });
      const trail = await d.inTenant(s.c, (tx) =>
        tx.ticketAssignment.findMany({
          where: { ticketId: ids.in_progress },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      );
      expect(trail.map((r) => [r.assignmentType, r.reasonCode])).toEqual([
        ['automatic', null],
        ['released', 'technician_unavailable'],
        ['automatic', null],
      ]);
      const attempts = await d.inTenant(s.c, (tx) =>
        tx.ticketDispatchAttempt.findMany({
          where: { ticketId: ids.in_progress },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      );
      expect(attempts.at(-1)).toMatchObject({
        trigger: 'role_lost',
        outcome: 'assigned',
        technicianId: rescuer.id,
      });
      expect(
        await notifications(
          s,
          s.supervisor.id,
          'ticket.technician_unavailable',
        ),
      ).toHaveLength(3);
      expect(
        await notifications(s, rescuer.id, 'ticket.assigned'),
      ).toHaveLength(3);
      // The technician left the pool, with the reason.
      const history = await d.inTenant(s.c, (tx) =>
        tx.technicianAvailabilityHistory.findMany({
          where: { accountId: holder.id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      );
      expect(history.at(-1)).toMatchObject({
        toState: 'unavailable',
        changedById: null,
        reasonCode: 'permission_lost',
      });
    });

    it('with nobody else the tickets wait in the queue and the dispatchers hear once', async () => {
      const { s, holder, ids, roles } = await scenario();
      await d.setAvailability(
        s.c,
        (
          await d.inTenant(s.c, (tx) =>
            tx.account.findFirstOrThrow({
              where: { role: { key: 'guard' }, type: 'staff' },
            }),
          )
        ).id,
        'unavailable',
      );
      await putPermissions(
        s,
        roles.technician,
        roles.technicianPermissions.filter((p) => p !== 'tickets.work'),
      ).expect(200);
      for (const status of ['assigned', 'in_progress', 'on_hold'])
        expect(await row(s, ids[status])).toMatchObject({
          status: 'new',
          technicianId: null,
        });
      expect(await row(s, ids.completed).then((r) => r.technicianId)).toBe(
        holder.id,
      );
      expect(
        await notifications(s, s.supervisor.id, 'ticket.unassignable'),
      ).toHaveLength(3);
    });

    it('granting a permission, or removing another one, releases nothing', async () => {
      const { s, holder, ids, roles } = await scenario();
      // Another permission a staff role may hold.
      const other = Object.entries(PERMISSIONS).find(
        ([name, def]) =>
          (def.kinds as readonly string[]).includes('staff') &&
          !roles.technicianPermissions.includes(name),
      )![0];
      await putPermissions(s, roles.technician, [
        ...roles.technicianPermissions,
        other,
      ]).expect(200);
      await putPermissions(
        s,
        roles.technician,
        roles.technicianPermissions,
      ).expect(200);
      for (const status of ['assigned', 'in_progress', 'on_hold'])
        expect((await row(s, ids[status])).technicianId).toBe(holder.id);
    });

    it('is atomic with the change: a failure in the handler leaves the permissions as they were', async () => {
      const { s, holder, ids, roles } = await scenario();
      failing = true;
      try {
        await putPermissions(
          s,
          roles.technician,
          roles.technicianPermissions.filter((p) => p !== 'tickets.work'),
        ).expect(500);
      } finally {
        failing = false;
      }
      expect((await roleIds(s)).technicianPermissions).toContain(
        'tickets.work',
      );
      // What the maintenance handler did before the failure rolled back too.
      expect((await row(s, ids.assigned)).technicianId).toBe(holder.id);
      expect(
        await notifications(
          s,
          s.supervisor.id,
          'ticket.technician_unavailable',
        ),
      ).toHaveLength(0);
    });

    it('races a manual assignment: nothing is left in the hands of someone who lost the permission', async () => {
      const { s, holder, roles } = await scenario();
      for (let i = 0; i < 4; i++) {
        await d.setAutoDispatch(s.c, false);
        const t = await d.openTicket(s);
        const results = await Promise.all([
          d.http(
            'post',
            `/maintenance/tickets/${t}/assign`,
            s.supervisor.token,
            { technicianId: holder.id },
          ),
          putPermissions(
            s,
            roles.technician,
            roles.technicianPermissions.filter((p) => p !== 'tickets.work'),
          ),
        ]);
        expect(results[1].status).toBe(200);
        expect([204, 404]).toContain(results[0].status);
        const held = await d.inTenant(s.c, (tx) =>
          tx.ticket.count({
            where: {
              technicianId: holder.id,
              status: { in: ['assigned', 'in_progress', 'on_hold'] },
            },
          }),
        );
        expect(held).toBe(0);
        await putPermissions(
          s,
          roles.technician,
          roles.technicianPermissions,
        ).expect(200);
        await d.setAutoDispatch(s.c, true);
      }
    });
  });

  describe('access:sync', () => {
    /** The catalog of a deploy that retires tickets.work. */
    const withoutWork: AccessCatalog = (() => {
      const permissions = { ...CODE_ACCESS_CATALOG.permissions } as Record<
        string,
        { kinds: readonly ('manager' | 'resident' | 'staff' | 'family')[] }
      >;
      delete permissions['tickets.work'];
      return {
        ...CODE_ACCESS_CATALOG,
        permissions,
        defaultRoles: CODE_ACCESS_CATALOG.defaultRoles.map((r) => ({
          ...r,
          permissions: r.permissions.filter((p) => p !== 'tickets.work'),
        })),
        retired: ['tickets.work'],
      };
    })();

    const sync = (tenantId: string, lifecycle: RoleLifecycle) =>
      new PermissionSyncService(
        withoutWork,
        h.moduleRef.get(GlobalDbService),
        h.moduleRef.get(TenantTx),
        h.moduleRef.get(AuditService),
        lifecycle,
      ).syncTenant(tenantId);

    it('run inside the app, it releases through the same hook (the deploy retired the permission for everyone, so the queue waits)', async () => {
      const { s, ids } = await scenario();
      await sync(s.c.tenantId, h.moduleRef.get(RoleLifecycle));
      for (const status of ['assigned', 'in_progress', 'on_hold'])
        expect(await row(s, ids[status])).toMatchObject({
          status: 'new',
          technicianId: null,
        });
      expect(
        await notifications(
          s,
          s.supervisor.id,
          'ticket.technician_unavailable',
        ),
      ).toHaveLength(3);
    });

    it('run as the CLI does (no domain handler), the sweep’s reconciliation releases them', async () => {
      const { s, holder, ids } = await scenario();
      await sync(s.c.tenantId, new RoleLifecycle());
      // Nothing reacted: the technician still holds the tickets.
      for (const status of ['assigned', 'in_progress', 'on_hold'])
        expect((await row(s, ids[status])).technicianId).toBe(holder.id);
      await h.moduleRef.get(DispatchSweep).run();
      for (const status of ['assigned', 'in_progress', 'on_hold'])
        expect(await row(s, ids[status])).toMatchObject({
          status: 'new',
          technicianId: null,
        });
      expect((await row(s, ids.completed)).technicianId).toBe(holder.id);
      expect(
        await notifications(
          s,
          s.supervisor.id,
          'ticket.technician_unavailable',
        ),
      ).toHaveLength(3);
      // A second pass finds nothing more to do.
      await h.moduleRef.get(DispatchSweep).run();
      expect(
        await notifications(
          s,
          s.supervisor.id,
          'ticket.technician_unavailable',
        ),
      ).toHaveLength(3);
    });
  });

  describe('the sweep’s reconciliation', () => {
    it('runs whatever the automatic dispatch setting says, and never touches a technician who still qualifies', async () => {
      const { s, holder, rescuer, ids } = await scenario();
      // The rescuer holds a ticket of their own, from a dispatcher.
      await d.setAutoDispatch(s.c, false);
      const mine = await d.openTicket(s);
      await d
        .http(
          'post',
          `/maintenance/tickets/${mine}/assign`,
          s.supervisor.token,
          {
            technicianId: rescuer.id,
          },
        )
        .expect(204);
      // Straight into the data, as a path that bypasses every hook would.
      await d.inTenant(s.c, (tx) =>
        tx.account.update({
          where: { id: holder.id },
          data: { status: 'inactive' },
        }),
      );
      await h.moduleRef.get(DispatchSweep).run();
      for (const status of ['assigned', 'in_progress', 'on_hold'])
        expect(await row(s, ids[status])).toMatchObject({
          status: 'new',
          technicianId: null,
        });
      expect(await row(s, mine)).toMatchObject({
        status: 'assigned',
        technicianId: rescuer.id,
      });
    });
  });
});
