import type { Response } from 'supertest';
import { call } from './request';
import type { World } from './world';

/** A real call for each no-store route of ADR 0063's inspections. */
export function inspectionCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  return {
    // The photos are presigned: A's owner reads its home's inspections.
    'GET /units/{unitId}/inspections': () => {
      const w = world();
      return call(w, 'GET', `/units/${w.a.homeUnitId}/inspections`, {
        token: w.a.tokens.owner,
      });
    },
  };
}
