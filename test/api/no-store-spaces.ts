import type { Response } from 'supertest';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { at, day } from '../setup/compound-clock';
import { fileHelpers } from '../setup/files';
import { buildingRow } from '../setup/units-rows';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of the spaces (ADR 0084), in A: the
 * site map's and the floor plans' presigned images, and a closure's
 * preview with its token.
 */
export function spacesCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const w = () => world();
  const manager = () => w().a.tokens.manager;
  const image = (purpose: 'site_map' | 'floor_plan') =>
    fileHelpers(w().h).ready(manager(), purpose);
  const setMap = async () =>
    call(w(), 'PUT', '/staff/site-map/image', {
      token: manager(),
      body: { fileId: await image('site_map') },
    });
  /** A plan on a floor of a building of its own: its id, and the building. */
  const plan = async () => {
    const buildingId = await w().helpers.asManager(w().a, () =>
      w()
        .h.moduleRef.get(TenantTx)
        .withTenantTx((tx) => buildingRow(tx, w().a.tenantId)),
    );
    const res = await call(w(), 'POST', '/staff/floor-plans', {
      token: manager(),
      body: { buildingId, floor: 1, fileId: await image('floor_plan') },
    });
    return { res, id: (res.body as { id: string }).id, buildingId };
  };
  return {
    'GET /staff/site-map': () =>
      call(w(), 'GET', '/staff/site-map', { token: manager() }),
    'PUT /staff/site-map/image': setMap,
    'PUT /staff/site-map/points': async () => {
      await setMap();
      return call(w(), 'PUT', '/staff/site-map/points', {
        token: manager(),
        body: { points: [] },
      });
    },
    'GET /site-map': () =>
      call(w(), 'GET', '/site-map', { token: w().a.tokens.owner }),
    'POST /staff/floor-plans': async () => (await plan()).res,
    'GET /staff/floor-plans/{id}': async () =>
      call(w(), 'GET', `/staff/floor-plans/${(await plan()).id}`, {
        token: manager(),
      }),
    'PUT /staff/floor-plans/{id}/image': async () =>
      call(w(), 'PUT', `/staff/floor-plans/${(await plan()).id}/image`, {
        token: manager(),
        body: { fileId: await image('floor_plan') },
      }),
    'PUT /staff/floor-plans/{id}/hotspots': async () =>
      call(w(), 'PUT', `/staff/floor-plans/${(await plan()).id}/hotspots`, {
        token: manager(),
        body: { hotspots: [] },
      }),
    'GET /units/{unitId}/floor-plan': async () => {
      // A home of its own on the plan's building and floor, and its owner.
      const { buildingId } = await plan();
      const home = await w().helpers.unit(w().a);
      await w().helpers.asManager(w().a, () =>
        w()
          .h.moduleRef.get(TenantTx)
          .withTenantTx((tx) =>
            tx.unit.update({
              where: { id: home.id },
              data: { buildingId, floor: 1 },
            }),
          ),
      );
      const owner = await w().helpers.resident(w().a, [home.id]);
      return call(w(), 'GET', `/units/${home.id}/floor-plan`, {
        token: await w().tokenFor(w().a, owner.id, 'resident'),
      });
    },
    'GET /staff/facilities/{id}/closure-preview': () =>
      call(w(), 'GET', `/staff/facilities/${w().aFacilityId}/closure-preview`, {
        token: manager(),
        query: {
          startsAt: at(day(40), 10).toISOString(),
          endsAt: at(day(40), 12).toISOString(),
        },
      }),
  };
}
