import type { Response } from 'supertest';
import { call } from './request';
import type { World } from './world';

/** A real call for each of the resident's lists of ADR 0058, as A's owner. */
export function residentItemCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const owner = (path: string, query?: Record<string, string>) =>
    call(world(), 'GET', path, { token: world().a.tokens.owner, query });
  return {
    'GET /me/appeals': () => owner('/me/appeals'),
    'GET /me/search': () => owner('/me/search', { q: 'MT-1' }),
    'GET /me/units/{unitId}/service-standing': () =>
      owner(`/me/units/${world().a.homeUnitId}/service-standing`),
  };
}
