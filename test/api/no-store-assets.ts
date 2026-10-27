import type { Response } from 'supertest';
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
  return {
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
