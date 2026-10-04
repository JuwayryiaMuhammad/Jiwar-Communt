import type { Server } from 'node:http';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import {
  TenantTx,
  type TenantTxClient,
} from '../../src/core/database/tenant-tx.service';
import { communityHelpers, type Compound } from './community';
import { gateHelpers } from './gate';
import { API, type HttpHarness } from './http-app';

/**
 * Helpers for the dispatch suites (ADR 0033): a compound with a supervisor
 * and technicians, calls over HTTP as any of them, and the dispatch tables
 * read straight from the database.
 */
export function dispatchHelpers(h: HttpHarness) {
  const x = communityHelpers(h);
  const g = gateHelpers(h);
  const cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
  const tenantTx = h.moduleRef.get(TenantTx);

  type Who = { id: string; token: string };

  async function who(
    c: Compound,
    id: string,
    type: 'staff' | 'manager' | 'resident',
  ): Promise<Who> {
    return {
      id,
      token: await h.tokenFor({ sub: id, tid: c.tenantId, typ: type }),
    };
  }

  /** A compound with a manager, a supervisor and `technicians` technicians. */
  async function setUp(technicians = 2) {
    const c = await x.compound();
    const manager = await who(c, c.managerId, 'manager');
    const sv = await g.guard(c, 'maintenance_supervisor');
    const supervisor = await who(c, sv.id, 'staff');
    const techs: Who[] = [];
    for (let i = 0; i < technicians; i++)
      techs.push(await who(c, (await g.guard(c, 'technician')).id, 'staff'));
    const unit = await x.unit(c);
    const owner = await x.resident(c, [unit.id]);
    return {
      c,
      manager,
      supervisor,
      techs,
      unit,
      owner: await who(c, owner.id, 'resident'),
    };
  }

  const http = (
    method: 'get' | 'post' | 'put' | 'patch',
    path: string,
    token: string,
    body?: object,
  ) => {
    const agent = request(h.app.getHttpServer() as Server);
    const req = agent[method](`${API}${path}`).set(
      'Authorization',
      `Bearer ${token}`,
    );
    return method === 'get' ? req : req.send(body ?? {});
  };

  /** Runs `fn` in a transaction of the compound's tenant. */
  function inTenant<T>(
    c: Compound,
    fn: (tx: TenantTxClient) => Promise<T>,
  ): Promise<T> {
    return cls.run(async () => {
      cls.set('tenantId', c.tenantId);
      return await tenantTx.withTenantTx(fn);
    });
  }

  type SetUp = Awaited<ReturnType<typeof setUp>>;

  /** A category of the compound by its key. */
  const categoryId = (c: Compound, key: string) =>
    inTenant(
      c,
      async (tx) =>
        (await tx.ticketCategory.findFirstOrThrow({ where: { key } })).id,
    );

  /** A specialty of the compound by its key. */
  const specialtyId = (c: Compound, key: string) =>
    inTenant(
      c,
      async (tx) =>
        (await tx.specialty.findFirstOrThrow({ where: { key } })).id,
    );

  /** Gives a technician exactly these specialties (by key), as a dispatcher would. */
  async function specialize(s: SetUp, tech: Who, keys: string[]) {
    const ids = await Promise.all(keys.map((k) => specialtyId(s.c, k)));
    await http(
      'put',
      `/maintenance/technicians/${tech.id}/specialties`,
      s.supervisor.token,
      {
        specialtyIds: ids,
      },
    ).expect(204);
  }

  /** A technician's availability, straight into the tables (setup, not a test). */
  const setAvailability = (
    c: Compound,
    technicianId: string,
    state: 'available' | 'unavailable',
  ) =>
    inTenant(c, (tx) =>
      tx.technicianAvailability.upsert({
        where: {
          tenantId_accountId: { tenantId: c.tenantId, accountId: technicianId },
        },
        create: { tenantId: c.tenantId, accountId: technicianId, state },
        update: { state },
      }),
    );

  /** A ticket the unit's resident opens, over HTTP; its id. */
  async function openTicket(
    s: SetUp,
    opts: {
      category?: string;
      priority?: 'normal' | 'urgent' | 'emergency';
    } = {},
  ): Promise<string> {
    const res = await http('post', '/tickets', s.owner.token, {
      unitId: s.unit.id,
      categoryId: await categoryId(s.c, opts.category ?? 'general'),
      description: 'Dispatch fixture',
      ...(opts.priority ? { priority: opts.priority } : {}),
    }).expect(201);
    return (res.body as { id: string }).id;
  }

  /** The ticket row. */
  const ticketRow = (c: Compound, id: string) =>
    inTenant(c, (tx) => tx.ticket.findUniqueOrThrow({ where: { id } }));

  /** Turns automatic dispatch on or off for the compound. */
  const setAutoDispatch = (c: Compound, enabled: boolean) =>
    inTenant(c, (tx) =>
      tx.maintenanceDispatchSettings.update({
        where: { tenantId: c.tenantId },
        data: { autoDispatchEnabled: enabled },
      }),
    );

  return {
    x,
    g,
    setUp,
    who,
    http,
    inTenant,
    categoryId,
    specialtyId,
    specialize,
    setAvailability,
    openTicket,
    ticketRow,
    setAutoDispatch,
  };
}
