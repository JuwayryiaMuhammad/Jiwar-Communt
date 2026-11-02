import type { Response } from 'supertest';
import { day } from '../setup/compound-clock';
import { call } from './request';
import type { World } from './world';

/** A real call for each no-store route of dispatch depth (ADR 0076), in A. */
export function dispatchDepthCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const manager = (path: string) =>
    call(world(), 'GET', path, { token: world().a.tokens.manager });
  return {
    'GET /maintenance/tickets/export': () =>
      manager(`/maintenance/tickets/export?from=${day(-30)}&to=${day(0)}`),
    'GET /maintenance/sla-report/export': () =>
      manager(`/maintenance/sla-report/export?from=${day(-30)}&to=${day(0)}`),
  };
}
