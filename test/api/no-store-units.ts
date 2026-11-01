import type { Response } from 'supertest';
import { call } from './request';
import type { World } from './world';

/** A real call for each no-store route of ADR 0072, as A's manager: the units' CSV and the staff's search. */
export function unitsCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  return {
    'GET /staff/units/export': () =>
      call(world(), 'GET', '/staff/units/export', {
        token: world().a.tokens.manager,
      }),
    'GET /staff/search': () =>
      call(world(), 'GET', '/staff/search', {
        token: world().a.tokens.manager,
        query: { q: 'U-' },
      }),
  };
}
