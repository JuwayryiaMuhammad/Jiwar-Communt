import { TicketsService } from '../../src/maintenance/tickets/tickets.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { assetHelpers } from './assets';
import { uniqueSuffix } from './fixtures';
import type { HttpHarness } from './http-app';

export interface PermitRead {
  id: string;
  ticketId: string;
  cycle: number;
  hazard: string;
  precautions: string;
  expiresAt: string;
  status: string;
  rejectReason: string | null;
  revokeReason: string | null;
  closedAt: string | null;
}

/** An instant `hours` from now, for a permit's expiry (an instant, not a day). */
export const hoursFromNow = (hours: number) =>
  new Date(Date.now() + hours * 3_600_000);

/**
 * Helpers for the field-safety suites (ADR 0067): the asset set-up (a
 * manager, a maintenance supervisor, technicians, a unit with its owner),
 * tickets in the first technician's hands, the hazards a category or an
 * asset type needs a permit for, and permits over HTTP.
 */
export function fieldSafetyHelpers(h: HttpHarness) {
  const a = assetHelpers(h);

  const setUp = (technicians = 1) => a.setUp(technicians);
  type SetUp = Awaited<ReturnType<typeof setUp>>;
  const tech = (s: SetUp, i = 0) => s.techs[i];

  /** A new category of the compound's (its own hazards); its id. */
  async function category(s: SetUp, hazards: string[] = []): Promise<string> {
    const key = `cat_${uniqueSuffix()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')}`;
    const res = await a
      .http('post', '/maintenance/categories', s.manager.token, {
        key,
        nameAr: 'أعمال',
        nameEn: 'Works',
      })
      .expect(201);
    const id = (res.body as { id: string }).id;
    if (hazards.length) await setHazards(s, id, hazards);
    return id;
  }

  const setHazards = (s: SetUp, categoryId: string, hazards: string[]) =>
    a
      .http(
        'put',
        `/maintenance/categories/${categoryId}/permit-hazards`,
        s.manager.token,
        { hazards },
      )
      .expect(200);

  /** A ticket of the unit's owner in `categoryId`, assigned to the technician; its id. */
  async function assigned(
    s: SetUp,
    categoryId: string,
    i = 0,
  ): Promise<string> {
    const res = await a
      .http('post', '/tickets', s.owner.token, {
        unitId: s.unit.id,
        categoryId,
        description: 'Field safety fixture',
      })
      .expect(201);
    const id = (res.body as { id: string }).id;
    await assign(s, id, i);
    return id;
  }

  /** A work order on `assetId`, assigned to the technician; its id. */
  async function workOrder(
    s: SetUp,
    assetId: string,
    categoryId: string,
    i = 0,
  ): Promise<string> {
    const ticket = await a.x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        h.moduleRef.get(TicketsService).createWorkOrder(tx, {
          tenantId: s.c.tenantId,
          origin: 'plan',
          assetId,
          categoryId,
          priority: 'normal',
          description: 'Field safety work order',
          responsibleId: s.supervisor.id,
          actorId: null,
        }),
      ),
    );
    await assign(s, ticket.id, i);
    return ticket.id;
  }

  const assign = (s: SetUp, id: string, i = 0) =>
    a
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: tech(s, i).id,
      })
      .expect(204);

  const step = (
    s: SetUp,
    id: string,
    action: 'start' | 'hold' | 'resume' | 'complete',
    body: object = {},
    i = 0,
  ) =>
    a.http(
      'post',
      `/technician/tickets/${id}/${action}`,
      tech(s, i).token,
      body,
    );

  const request = (s: SetUp, id: string, body: object = {}, i = 0) =>
    a.http('post', `/technician/tickets/${id}/permits`, tech(s, i).token, {
      hazard: 'height',
      precautions: 'Harness, a spotter, the area taped off',
      expiresAt: hoursFromNow(4).toISOString(),
      ...body,
    });

  async function permit(
    s: SetUp,
    id: string,
    body: object = {},
  ): Promise<PermitRead> {
    return (await request(s, id, body).expect(201)).body as PermitRead;
  }

  const decide = (
    s: SetUp,
    permitId: string,
    action: 'approve' | 'reject' | 'revoke',
    reasonCode?: string,
  ) =>
    a.http(
      'post',
      `/maintenance/work-permits/${permitId}/${action}`,
      s.supervisor.token,
      reasonCode ? { reasonCode } : {},
    );

  /** An approved permit for `hazard` on the ticket. */
  async function approved(
    s: SetUp,
    id: string,
    hazard = 'height',
  ): Promise<PermitRead> {
    const p = await permit(s, id, { hazard });
    return (await decide(s, p.id, 'approve').expect(200)).body as PermitRead;
  }

  return {
    ...a,
    setUp,
    tech,
    category,
    setHazards,
    assigned,
    workOrder,
    step,
    request,
    permit,
    decide,
    approved,
  };
}

export type FieldSafetySetUp = Awaited<
  ReturnType<ReturnType<typeof fieldSafetyHelpers>['setUp']>
>;
