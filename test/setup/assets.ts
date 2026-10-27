import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { FacilitiesService } from '../../src/facilities/setup/facilities.service';
import { ChecklistRuns } from '../../src/maintenance/checklists/checklist-runs';
import { TicketsService } from '../../src/maintenance/tickets/tickets.service';
import type { Compound } from './community';
import { communityHelpers } from './community';
import { dispatchHelpers } from './dispatch';
import { uniqueSuffix } from './fixtures';
import type { HttpHarness } from './http-app';

/**
 * Helpers for the asset suites (ADR 0064): the dispatch set-up (a manager,
 * a supervisor, technicians, a unit and its owner) with the unit placed in
 * a building, and the register's rows made over HTTP as the manager.
 */
export function assetHelpers(h: HttpHarness) {
  const d = dispatchHelpers(h);
  const x = communityHelpers(h);

  async function setUp(technicians = 1) {
    const s = await d.setUp(technicians);
    const building = `Tower ${uniqueSuffix()}`;
    await d.inTenant(s.c, (tx) =>
      tx.unit.update({ where: { id: s.unit.id }, data: { building } }),
    );
    return { ...s, building };
  }
  type SetUp = Awaited<ReturnType<typeof setUp>>;

  /** A common area of kind `area` (or as `body` says); its view. */
  async function area(
    s: SetUp,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; code: string } & Record<string, unknown>> {
    const res = await d
      .http('post', '/maintenance/areas', s.manager.token, {
        kind: 'area',
        code: `A-${uniqueSuffix()}`,
        nameAr: 'غرفة المضخات',
        nameEn: 'Pump room',
        ...body,
      })
      .expect(201);
    return res.body as { id: string; code: string };
  }

  /** A walk-in facility of the compound, through its own service. */
  const facility = (c: Compound) =>
    x.asManager(c, () =>
      h.moduleRef.get(FacilitiesService).create({
        mode: 'walk_in',
        nameEn: 'Pool',
        nameAr: 'حمام السباحة',
      }),
    );

  /** A type of the compound by its key. */
  async function typeId(s: SetUp, key: string): Promise<string> {
    const res = await d
      .http('get', '/maintenance/asset-types', s.manager.token)
      .expect(200);
    return (res.body as { data: { id: string; key: string }[] }).data.find(
      (t) => t.key === key,
    )!.id;
  }

  /** An asset of `type` (a pump by default) in a new area, or as `body` says. */
  async function asset(
    s: SetUp,
    body: Record<string, unknown> = {},
  ): Promise<string> {
    const place =
      body.unitId || body.commonAreaId || body.parentId
        ? {}
        : { commonAreaId: (await area(s)).id };
    const res = await d
      .http('post', '/maintenance/assets', s.manager.token, {
        code: `T-${uniqueSuffix()}`,
        typeId: await typeId(s, 'pump'),
        nameAr: 'مضخة',
        nameEn: 'Pump',
        ...place,
        ...body,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  /** A checklist of `items` (one check by default); its id and item ids. */
  async function checklist(
    s: SetUp,
    items: Record<string, unknown>[] = [
      { kind: 'check', labelAr: 'تسريب', labelEn: 'No leaks' },
    ],
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; items: { id: string; position: number }[] }> {
    const res = await d
      .http('post', '/maintenance/checklists', s.manager.token, {
        key: `cl_${uniqueSuffix()
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')}`,
        nameAr: 'فحص',
        nameEn: 'Check-up',
        purpose: 'any',
        items,
        ...body,
      })
      .expect(201);
    return res.body as {
      id: string;
      items: { id: string; position: number }[];
    };
  }

  /**
   * A work order of the compound's on `assetId` with `checklistId`'s run,
   * assigned to the first technician and started: what a plan's job is
   * once in hand. Its ticket id.
   */
  async function jobWithChecklist(
    s: SetUp,
    assetId: string,
    checklistId: string,
    origin: 'plan' | 'inspection' | 'field' = 'plan',
  ): Promise<string> {
    const categoryId = await d.categoryId(s.c, 'plumbing');
    const ticket = await x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx(async (tx) => {
        const t = await h.moduleRef.get(TicketsService).createWorkOrder(tx, {
          tenantId: s.c.tenantId,
          origin,
          assetId,
          categoryId,
          priority: 'normal',
          description: 'Planned job',
          responsibleId: s.supervisor.id,
          actorId: null,
        });
        await h.moduleRef.get(ChecklistRuns).open(tx, {
          tenantId: s.c.tenantId,
          templateId: checklistId,
          ticketId: t.id,
          cycle: 1,
          assetId,
        });
        return t;
      }),
    );
    await d
      .http(
        'post',
        `/maintenance/tickets/${ticket.id}/assign`,
        s.supervisor.token,
        {
          technicianId: s.techs[0].id,
        },
      )
      .expect(204);
    await d
      .http('post', `/technician/tickets/${ticket.id}/start`, s.techs[0].token)
      .expect(204);
    return ticket.id;
  }

  return {
    ...d,
    x,
    setUp,
    area,
    facility,
    typeId,
    asset,
    checklist,
    jobWithChecklist,
  };
}

export type AssetSetUp = Awaited<
  ReturnType<ReturnType<typeof assetHelpers>['setUp']>
>;
