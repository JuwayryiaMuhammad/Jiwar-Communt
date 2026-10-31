import type { Response } from 'supertest';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of ADR 0070's club requests, in
 * compound A: the owner asks for A's plan for the home; the tenant asks for
 * the rented unit and calls it off.
 */
export function clubRequestCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const as = (
    persona: 'owner' | 'tenant' | 'manager',
    method: 'GET' | 'POST',
    path: string,
    body?: object,
  ) => call(world(), method, path, { token: world().a.tokens[persona], body });
  return {
    'POST /units/{unitId}/club-membership/requests': () =>
      as(
        'owner',
        'POST',
        `/units/${world().a.homeUnitId}/club-membership/requests`,
        { planId: world().aClubPlanId },
      ),
    'GET /units/{unitId}/club-membership/requests': () =>
      as(
        'owner',
        'GET',
        `/units/${world().a.homeUnitId}/club-membership/requests`,
      ),
    'GET /staff/club/requests': () =>
      as('manager', 'GET', '/staff/club/requests'),
    'POST /club-membership-requests/{id}/cancel': async () => {
      const req = await as(
        'tenant',
        'POST',
        `/units/${world().a.rentedUnitId}/club-membership/requests`,
        { planId: world().aClubPlanId },
      ).expect(201);
      return as(
        'tenant',
        'POST',
        `/club-membership-requests/${(req.body as { id: string }).id}/cancel`,
        { reasonCode: 'other' },
      );
    },
  };
}
