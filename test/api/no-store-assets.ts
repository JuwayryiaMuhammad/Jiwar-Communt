import type { Response } from 'supertest';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { ChecklistRuns } from '../../src/maintenance/checklists/checklist-runs';
import { TicketsService } from '../../src/maintenance/tickets/tickets.service';
import { fileHelpers } from '../setup/files';
import { uniqueSuffix } from '../setup/fixtures';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of ADR 0064, as A's manager: a tag
 * shown once, and the documents' presigned URLs.
 */
export function assetCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const manager = (method: 'GET' | 'POST', path: string, payload?: object) =>
    call(world(), method, path, {
      token: world().a.tokens.manager,
      body: payload,
    });
  const area = async (): Promise<string> =>
    (
      (
        await manager('POST', '/maintenance/areas', {
          kind: 'area',
          code: `NS-${uniqueSuffix()}`,
          nameAr: 'غرفة',
          nameEn: 'Call room',
        })
      ).body as { id: string }
    ).id;
  const asset = async (): Promise<string> => {
    const types = (await manager('GET', '/maintenance/asset-types')).body as {
      data: { id: string; key: string }[];
    };
    const created = await manager('POST', '/maintenance/assets', {
      code: `NS-${uniqueSuffix()}`,
      typeId: types.data.find((t) => t.key === 'pump')!.id,
      commonAreaId: await area(),
      nameAr: 'مضخة',
      nameEn: 'Call pump',
    });
    return (created.body as { id: string }).id;
  };
  const document = async (assetId: string) =>
    manager('POST', '/maintenance/documents', {
      assetId,
      fileId: await fileHelpers(world().h).ready(
        world().a.tokens.manager,
        'asset_document',
        'application/pdf',
      ),
      kind: 'manual',
      title: 'Call manual',
    });
  /**
   * A work order of A's on a new asset, with a one-check checklist, given
   * to A's technician and started: its id and the item's.
   */
  const job = async (): Promise<{ ticketId: string; itemId: string }> => {
    const w = world();
    const assetId = await asset();
    const checklist = (
      await manager('POST', '/maintenance/checklists', {
        key: `ns_${uniqueSuffix()
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')}`,
        nameAr: 'فحص',
        nameEn: 'Call check',
        purpose: 'pm',
        items: [{ kind: 'check', labelAr: 'ت', labelEn: 'Leaks' }],
      })
    ).body as { id: string; items: { id: string }[] };
    const ticketId = await w.helpers.asManager(w.a, () =>
      w.h.moduleRef.get(TenantTx).withTenantTx(async (tx) => {
        const category = await tx.ticketCategory.findFirstOrThrow({
          where: { key: 'plumbing' },
        });
        const t = await w.h.moduleRef.get(TicketsService).createWorkOrder(tx, {
          tenantId: w.a.tenantId,
          origin: 'plan',
          assetId,
          categoryId: category.id,
          priority: 'normal',
          description: 'Call job',
          responsibleId: w.a.ids.manager,
          actorId: null,
        });
        await w.h.moduleRef.get(ChecklistRuns).open(tx, {
          tenantId: w.a.tenantId,
          templateId: checklist.id,
          ticketId: t.id,
          cycle: 1,
          assetId,
        });
        return t.id;
      }),
    );
    await manager('POST', `/maintenance/tickets/${ticketId}/assign`, {
      technicianId: w.a.ids.technician,
    });
    await technician('POST', `/technician/tickets/${ticketId}/start`);
    return { ticketId, itemId: checklist.items[0].id };
  };
  const technician = (
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    payload?: object,
  ) =>
    call(world(), method, path, {
      token: world().a.tokens.technician,
      body: payload,
    });

  return {
    'GET /technician/tickets/{id}/checklist': async () =>
      technician(
        'GET',
        `/technician/tickets/${(await job()).ticketId}/checklist`,
      ),
    'PUT /technician/tickets/{id}/checklist/items/{itemId}': async () => {
      const { ticketId, itemId } = await job();
      return technician(
        'PUT',
        `/technician/tickets/${ticketId}/checklist/items/${itemId}`,
        { result: 'pass' },
      );
    },
    'POST /technician/tickets/{id}/checklist/submit': async () => {
      const { ticketId, itemId } = await job();
      await technician(
        'PUT',
        `/technician/tickets/${ticketId}/checklist/items/${itemId}`,
        {
          result: 'pass',
        },
      );
      return technician(
        'POST',
        `/technician/tickets/${ticketId}/checklist/submit`,
      );
    },
    'GET /maintenance/tickets/{id}/checklist': async () =>
      manager(
        'GET',
        `/maintenance/tickets/${(await job()).ticketId}/checklist`,
      ),
    'POST /maintenance/areas/{id}/tag': async () =>
      manager('POST', `/maintenance/areas/${await area()}/tag`),
    'POST /maintenance/assets/{id}/tag': async () =>
      manager('POST', `/maintenance/assets/${await asset()}/tag`),
    'POST /maintenance/documents': async () => document(await asset()),
    'GET /maintenance/documents': async () => {
      const id = await asset();
      await document(id);
      return manager('GET', `/maintenance/documents?assetId=${id}`);
    },
  };
}
