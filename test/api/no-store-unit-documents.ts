import type { Response } from 'supertest';
import { communityHelpers } from '../setup/community';
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
  /** An ownership contract binding A's owner in A's home: its id. */
  const contract = async () => {
    const w = world();
    const x = communityHelpers(w.h);
    const occupancy = await x.asManager(w.a, () =>
      x.prisma.tenant.unitOccupancy.findFirstOrThrow({
        where: {
          unitId: w.a.homeUnitId,
          accountId: w.a.ids.owner,
          status: 'active',
        },
      }),
    );
    const fileId = await fileHelpers(w.h).ready(
      w.a.tokens.manager,
      'contract',
      'application/pdf',
    );
    const res = await call(
      w,
      'POST',
      `/staff/units/${w.a.homeUnitId}/contracts`,
      {
        token: w.a.tokens.manager,
        body: {
          kind: 'ownership',
          partyOccupancyIds: [occupancy.id],
          signedOn: '2026-01-01',
          startsOn: '2026-01-01',
          fileId,
        },
      },
    );
    return (res.body as { id: string }).id;
  };
  /** A fresh unit of A with an owner living there: no money owed. */
  const freshHome = async () => {
    const w = world();
    const x = communityHelpers(w.h);
    const unit = await x.unit(w.a);
    const owner = await x.resident(w.a, [unit.id]);
    return {
      unitId: unit.id,
      token: await w.tokenFor(w.a, owner.id, 'resident'),
    };
  };
  const cleared = async () => {
    const home = await freshHome();
    const res = await call(
      world(),
      'POST',
      `/units/${home.unitId}/clearances`,
      {
        token: home.token,
      },
    );
    const body = res.body as { id: string; verifyCode: string };
    return { ...home, ...body };
  };
  return {
    'POST /units/{unitId}/clearances': async () => {
      const home = await freshHome();
      return call(world(), 'POST', `/units/${home.unitId}/clearances`, {
        token: home.token,
      });
    },
    'GET /units/{unitId}/clearances': async () => {
      const c = await cleared();
      return call(world(), 'GET', `/units/${c.unitId}/clearances`, {
        token: c.token,
      });
    },
    'GET /clearances/{id}/certificate': async () => {
      const c = await cleared();
      return call(world(), 'GET', `/clearances/${c.id}/certificate`, {
        token: c.token,
      });
    },
    'POST /staff/units/{unitId}/clearances': async () => {
      const home = await freshHome();
      return call(world(), 'POST', `/staff/units/${home.unitId}/clearances`, {
        token: world().a.tokens.manager,
      });
    },
    'GET /staff/clearances/{id}/certificate': async () => {
      const c = await cleared();
      return call(world(), 'GET', `/staff/clearances/${c.id}/certificate`, {
        token: world().a.tokens.manager,
      });
    },
    'POST /public/clearances/lookup': async () => {
      const c = await cleared();
      return call(world(), 'POST', '/public/clearances/lookup', {
        body: { code: c.verifyCode },
      });
    },
    'GET /units/{unitId}/contracts/{id}': async () =>
      call(
        world(),
        'GET',
        `/units/${world().a.homeUnitId}/contracts/${await contract()}`,
        { token: world().a.tokens.owner },
      ),
    'GET /staff/units/{unitId}/contracts/{id}': async () =>
      call(
        world(),
        'GET',
        `/staff/units/${world().a.homeUnitId}/contracts/${await contract()}`,
        { token: world().a.tokens.manager },
      ),
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
