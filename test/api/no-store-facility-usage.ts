import type { Response } from 'supertest';
import { call } from './request';
import type { World } from './world';

/** A real call for each no-store route of ADR 0067, as A's manager: the facilities' usage CSV. */
export function facilityUsageCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  return {
    'GET /staff/facility-usage/export': () =>
      call(world(), 'GET', '/staff/facility-usage/export', {
        token: world().a.tokens.manager,
      }),
  };
}
