import type { Response } from 'supertest';
import { call } from './request';
import type { World } from './world';

/** A real call for each no-store route of ADR 0066, as A's manager: the consumption CSV. */
export function energyCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  return {
    'GET /maintenance/energy/consumption/export': () =>
      call(world(), 'GET', '/maintenance/energy/consumption/export', {
        token: world().a.tokens.manager,
        query: { kind: 'water' },
      }),
  };
}
