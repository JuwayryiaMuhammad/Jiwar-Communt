import { err } from '../api/request';
import { ExportSections } from '../../src/core/exports/export-sections';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { TicketsService } from '../../src/maintenance/tickets/tickets.service';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import { at, day } from '../setup/compound-clock';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type Origin = 'plan' | 'inspection' | 'field';

/**
 * ADR 0064: the compound's own work orders on the tickets, and the one
 * rule of the resident side. A field ticket on an asset in a unit is the
 * household's to see, with its visits; every other work order is out of
 * every resident view: unit tickets, my tickets, my requests and their
 * search, visits, notifications, the daily brief and the personal-data
 * export. Dispatch accepts or sends back the compound's; a quote is never
 * asked of a household for them.
 */
describe('Assets — work orders and the resident side', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let s: AssetSetUp;
  let pump: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    s = await a.setUp(1);
    pump = (
      (
        await a
          .http('get', '/maintenance/asset-types', s.manager.token)
          .expect(200)
      ).body as {
        data: { id: string; key: string }[];
      }
    ).data.find((t) => t.key === 'pump')!.id;
    await a.specialize(s, s.techs[0], ['plumbing']);
    await a.setAvailability(s.c, s.techs[0].id, 'available');
  }, 90_000);

  afterAll(() => h.close());

  async function asset(place: { unitId?: string; commonAreaId?: string }) {
    return (
      (
        await a
          .http('post', '/maintenance/assets', s.manager.token, {
            code: `WO-${uniqueSuffix()}`,
            typeId: pump,
            nameAr: 'مضخة',
            nameEn: 'Pump',
            ...place,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  }

  /** A work order opened as the service opens them; its id. */
  async function workOrder(origin: Origin, assetId: string): Promise<string> {
    const categoryId = await a.categoryId(s.c, 'plumbing');
    const ticket = await a.x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        h.moduleRef.get(TicketsService).createWorkOrder(tx, {
          tenantId: s.c.tenantId,
          origin,
          assetId,
          categoryId,
          priority: 'normal',
          description: `Work order ${origin}`,
          responsibleId: origin === 'field' ? s.techs[0].id : s.supervisor.id,
          actorId: origin === 'plan' ? null : s.supervisor.id,
        }),
      ),
    );
    return ticket.id;
  }

  const residentSees = async (ticketId: string) => {
    const t = s.owner.token;
    const list = (await a.http('get', '/tickets?limit=100', t).expect(200))
      .body as { data: { id: string }[] };
    const unitList = (
      await a
        .http('get', `/tickets?unitId=${s.unit.id}&limit=100`, t)
        .expect(200)
    ).body as { data: { id: string }[] };
    const detail = await a.http('get', `/tickets/${ticketId}`, t);
    const requests = (
      await a.http('get', '/me/requests?limit=100', t).expect(200)
    ).body as {
      data: { id: string }[];
    };
    const number = (
      await a.inTenant(s.c, (tx) =>
        tx.ticket.findUniqueOrThrow({ where: { id: ticketId } }),
      )
    ).number;
    const search = (
      await a
        .http(
          'get',
          `/me/search?q=${`MT-${String(number).padStart(6, '0')}`}`,
          t,
        )
        .expect(200)
    ).body as { data: { id: string }[] };
    const visits = (
      await a.http('get', `/me/units/${s.unit.id}/visits`, t).expect(200)
    ).body as { data: { ticketId: string }[] };
    const notices = await a.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { accountId: s.owner.id, targetId: ticketId },
      }),
    );
    const exported: string[] = [];
    const section = h.moduleRef
      .get(ExportSections)
      .all()
      .find(([name]) => name === 'tickets')![1];
    await a.x.as(s.c, { id: s.owner.id, type: 'resident' }, async () => {
      for await (const entry of section({
        accountId: s.owner.id,
        tenantId: s.c.tenantId,
        accountType: 'resident',
      }))
        exported.push(JSON.stringify(entry));
    });
    return {
      list: list.data.some((x) => x.id === ticketId),
      unitList: unitList.data.some((x) => x.id === ticketId),
      detail: detail.status,
      requests: requests.data.some((x) => x.id === ticketId),
      search: search.data.some((x) => x.id === ticketId),
      visits: visits.data.some((v) => v.ticketId === ticketId),
      notices: notices.map((n) => n.kind),
      exported: exported.some((e) => e.includes(ticketId)),
    };
  };

  const assign = (id: string) =>
    a
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: s.techs[0].id,
      })
      .expect((r) => expect([200, 201, 204, 409]).toContain(r.status));
  const work = async (id: string) => {
    await assign(id);
    await a
      .http('post', `/technician/tickets/${id}/start`, s.techs[0].token)
      .expect(204);
    await a
      .http('post', `/technician/tickets/${id}/complete`, s.techs[0].token)
      .expect(204);
  };

  it('a plan’s or an inspection’s work order, even on an asset in the unit, is in no resident view', async () => {
    for (const origin of ['plan', 'inspection'] as const) {
      const id = await workOrder(origin, await asset({ unitId: s.unit.id }));
      await work(id);
      expect(await residentSees(id)).toEqual({
        list: false,
        unitList: false,
        detail: 404,
        requests: false,
        search: false,
        visits: false,
        notices: [],
        exported: false,
      });
    }
    const area = await a.area(s);
    const inArea = await workOrder(
      'inspection',
      await asset({ commonAreaId: area.id }),
    );
    expect((await residentSees(inArea)).detail).toBe(404);
  });

  it('a field ticket on an asset in the unit is the household’s to see, with its visits; nothing to confirm or escalate', async () => {
    const id = await workOrder('field', await asset({ unitId: s.unit.id }));
    await assign(id);
    // The technician proposes a visit: the household is told and sees it.
    await a
      .http('post', `/technician/tickets/${id}/visits`, s.techs[0].token, {
        startsAt: at(day(2), 10).toISOString(),
        endsAt: at(day(2), 11).toISOString(),
      })
      .expect(201);
    const seen = await residentSees(id);
    expect(seen).toMatchObject({
      list: true,
      unitList: true,
      detail: 200,
      requests: true,
      search: true,
      visits: true,
      exported: false,
    });
    expect(seen.notices).toEqual(['ticket.visit_proposed']);
    const view = (
      await a.http('get', `/tickets/${id}`, s.owner.token).expect(200)
    ).body as {
      origin: string;
    };
    expect(view.origin).toBe('field');
    await a
      .http('post', `/tickets/${id}/escalate`, s.owner.token)
      .expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
    await a
      .http('post', `/technician/tickets/${id}/start`, s.techs[0].token)
      .expect(204);
    await a
      .http('post', `/technician/tickets/${id}/complete`, s.techs[0].token)
      .expect(204);
    // Not the household's to confirm: dispatch closes it. The visit it was
    // offered ended with the work, and it was told so; nothing else.
    await a
      .http('post', `/tickets/${id}/confirm`, s.owner.token, { rating: 5 })
      .expect(403);
    expect((await residentSees(id)).notices.sort()).toEqual([
      'ticket.visit_cancelled',
      'ticket.visit_proposed',
    ]);
    await a
      .http(
        'post',
        `/maintenance/tickets/${id}/accept-work`,
        s.supervisor.token,
      )
      .expect(204);
  });

  it('the daily brief counts and names only what the household sees: a field ticket in the unit, no plan’s or inspection’s', async () => {
    const brief = async () =>
      (
        (await a.http('get', '/me/daily-brief', s.owner.token).expect(200))
          .body as {
          tickets: {
            open: number;
            latest: { id: string } | null;
          } | null;
        }
      ).tickets!;
    const before = await brief();
    // Open work orders on an asset in the unit, the newest activity of all:
    // neither counts nor shows as the latest.
    for (const origin of ['plan', 'inspection'] as const)
      await workOrder(origin, await asset({ unitId: s.unit.id }));
    expect(await brief()).toEqual(before);
    // The field ticket in the unit is the household's: counted, and the
    // latest.
    const field = await workOrder('field', await asset({ unitId: s.unit.id }));
    const after = await brief();
    expect(after.open).toBe(before.open + 1);
    expect(after.latest?.id).toBe(field);
  });

  it('dispatch accepts or sends back a work order, never a resident’s ticket; a quote is never asked', async () => {
    const area = await a.area(s);
    const id = await workOrder(
      'inspection',
      await asset({ commonAreaId: area.id }),
    );
    await a
      .http('post', `/maintenance/tickets/${id}/quotes`, s.supervisor.token, {
        amount: '150',
      })
      .expect(409)
      .expect((r) => expect(err(r).code).toBe('TICKET_QUOTE_NOT_ALLOWED'));
    await work(id);
    await a
      .http(
        'post',
        `/maintenance/tickets/${id}/send-back`,
        s.supervisor.token,
        {
          reasonCode: 'not_fixed',
          reason: 'Still leaking at the joint',
        },
      )
      .expect(204);
    const back = await a.inTenant(s.c, (tx) =>
      tx.ticket.findUniqueOrThrow({ where: { id } }),
    );
    expect(back).toMatchObject({
      cycle: 2,
      technicianId: s.techs[0].id,
      status: 'assigned',
    });
    await a
      .http('post', `/technician/tickets/${id}/start`, s.techs[0].token)
      .expect(204);
    await a
      .http('post', `/technician/tickets/${id}/complete`, s.techs[0].token)
      .expect(204);
    await a
      .http('post', `/maintenance/tickets/${id}/accept-work`, s.techs[0].token)
      .expect(403);
    await a
      .http(
        'post',
        `/maintenance/tickets/${id}/accept-work`,
        s.supervisor.token,
      )
      .expect(204);
    expect(
      await a.inTenant(s.c, (tx) =>
        tx.ticket.findUniqueOrThrow({ where: { id } }),
      ),
    ).toMatchObject({ status: 'closed', confirmationStatus: 'confirmed' });
    // The staff reporter heard nothing meant for a resident.
    const told = await a.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { accountId: s.supervisor.id, targetId: id },
      }),
    );
    expect(told.map((n) => n.kind)).not.toContain('ticket.completed');
    // A resident's ticket is theirs to confirm.
    const theirs = await a.openTicket(s, { category: 'plumbing' });
    await a
      .http(
        'post',
        `/maintenance/tickets/${theirs}/accept-work`,
        s.supervisor.token,
      )
      .expect(409)
      .expect((r) => expect(err(r).code).toBe('TICKET_NOT_WORK_ORDER'));
  });

  it('the dispatch list filters by origin and asset; the views say where a work order is', async () => {
    const area = await a.area(s);
    const assetId = await asset({ commonAreaId: area.id });
    const id = await workOrder('plan', assetId);
    const listed = (
      await a
        .http(
          'get',
          `/maintenance/tickets?origin=plan&assetId=${assetId}`,
          s.supervisor.token,
        )
        .expect(200)
    ).body as {
      data: {
        id: string;
        origin: string;
        assetId: string;
        commonAreaId: string;
        commonArea: string;
      }[];
    };
    expect(listed.data).toEqual([
      expect.objectContaining({
        id,
        origin: 'plan',
        assetId,
        commonAreaId: area.id,
        commonArea: 'Pump room',
      }),
    ]);
    const residents = (
      await a
        .http(
          'get',
          '/maintenance/tickets?origin=resident&limit=100',
          s.supervisor.token,
        )
        .expect(200)
    ).body as { data: { origin: string }[] };
    expect(residents.data.every((t) => t.origin === 'resident')).toBe(true);
  });

  it('the database keeps a ticket’s origin, asset and area, and a resident ticket names none', async () => {
    const area = await a.area(s);
    const id = await workOrder(
      'inspection',
      await asset({ commonAreaId: area.id }),
    );
    await expect(
      a.inTenant(
        s.c,
        (tx) =>
          tx.$executeRaw`UPDATE tickets SET origin = 'resident' WHERE id = ${id}::uuid`,
      ),
    ).rejects.toThrow();
    const theirs = await a.openTicket(s, { category: 'plumbing' });
    await expect(
      a.inTenant(
        s.c,
        (tx) =>
          tx.$executeRaw`UPDATE tickets SET asset_id = (SELECT asset_id FROM tickets WHERE id = ${id}::uuid) WHERE id = ${theirs}::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('a retired asset takes no work order', async () => {
    const area = await a.area(s);
    const assetId = await asset({ commonAreaId: area.id });
    await a
      .http('post', `/maintenance/assets/${assetId}/retire`, s.manager.token, {
        reasonCode: 'disposed',
      })
      .expect(201);
    await expect(workOrder('plan', assetId)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ASSET_RETIRED' }) as unknown,
    });
  });
});
