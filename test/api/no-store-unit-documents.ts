import type { Response } from 'supertest';
import { fileHelpers } from '../setup/files';
import { call } from './request';
import type { World } from './world';

/** A real call for each no-store route of ADR 0062's unit vault. */
export function unitDocumentCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  /** A document filed in A's home by `who`; its id. */
  const filed = async (who: 'owner' | 'manager', staff: boolean) => {
    const w = world();
    const fileId = await fileHelpers(w.h).ready(
      w.a.tokens[who],
      'unit_document',
      'application/pdf',
    );
    const res = await call(
      w,
      'POST',
      `${staff ? '/staff' : ''}/units/${w.a.homeUnitId}/documents`,
      {
        token: w.a.tokens[who],
        body: {
          fileId,
          kind: 'manual',
          title: 'Boiler manual',
          visibility: 'occupants',
        },
      },
    );
    return (res.body as { id: string }).id;
  };
  return {
    'GET /compound-documents/versions/{id}': async () => {
      const w = world();
      const res = await call(w, 'POST', '/staff/compound-documents/versions', {
        token: w.a.tokens.manager,
        body: {
          kind: 'moving_guide',
          titleEn: 'Moving guide',
          titleAr: 'دليل الانتقال',
          bodyEn: 'Book the lift.',
          bodyAr: 'احجز المصعد.',
          effectiveOn: '2026-01-01',
        },
      });
      const { id } = res.body as { id: string };
      return call(w, 'GET', `/compound-documents/versions/${id}`, {
        token: w.a.tokens.owner,
      });
    },
    'GET /units/{unitId}/documents/{id}': async () =>
      call(
        world(),
        'GET',
        `/units/${world().a.homeUnitId}/documents/${await filed('owner', false)}`,
        { token: world().a.tokens.owner },
      ),
    'GET /staff/units/{unitId}/documents/{id}': async () =>
      call(
        world(),
        'GET',
        `/staff/units/${world().a.homeUnitId}/documents/${await filed('manager', true)}`,
        { token: world().a.tokens.manager },
      ),
  };
}
