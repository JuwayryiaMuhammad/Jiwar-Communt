import { FacilitiesService } from '../../src/facilities/setup/facilities.service';
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

  return { ...d, x, setUp, area, facility };
}

export type AssetSetUp = Awaited<
  ReturnType<ReturnType<typeof assetHelpers>['setUp']>
>;
