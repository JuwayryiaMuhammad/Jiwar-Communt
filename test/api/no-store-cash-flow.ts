import type { Response } from 'supertest';
import { call } from './request';
import type { World } from './world';

/** A real call for each no-store route of cash flow (ADR 0091), in A. */
export function cashFlowCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const manager = (method: 'GET' | 'PATCH', path: string, body?: object) =>
    call(world(), method, path, {
      token: world().a.tokens.manager,
      ...(body ? { body } : {}),
    });
  return {
    'GET /staff/finance/cash-flow': () =>
      manager('GET', '/staff/finance/cash-flow'),
    'GET /staff/finance/cash-flow/export': () =>
      manager('GET', '/staff/finance/cash-flow/export?by=month&periods=3'),
    'GET /staff/finance/cash-flow/settings': () =>
      manager('GET', '/staff/finance/cash-flow/settings'),
    'PATCH /staff/finance/cash-flow/settings': () =>
      manager('PATCH', '/staff/finance/cash-flow/settings', {
        minimumCash: null,
      }),
  };
}
