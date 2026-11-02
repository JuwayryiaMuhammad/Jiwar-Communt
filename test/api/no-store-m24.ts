import type { Response } from 'supertest';
import { today } from '../setup/compound-clock';
import { call } from './request';
import type { World } from './world';

/** A real call for each no-store route of the operations dashboard (ADR 0079), in A. */
export function m24Calls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  return {
    'POST /staff/gate/log-search/export': () =>
      call(world(), 'POST', '/staff/gate/log-search/export', {
        token: world().a.tokens.manager,
        body: { from: today(), to: today() },
      }),
  };
}
