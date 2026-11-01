import type { Response } from 'supertest';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of the staff inbox (ADR 0073), in A,
 * as its manager.
 */
export function m23Calls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const manager = () => world().a.tokens.manager;
  return {
    'GET /staff/inbox': () =>
      call(world(), 'GET', '/staff/inbox', { token: manager() }),
    'GET /staff/inbox/count': () =>
      call(world(), 'GET', '/staff/inbox/count', { token: manager() }),
    // An unknown permit: its outcome is the permit's own refusal, the answer 200.
    'POST /staff/inbox/bulk-approve': () =>
      call(world(), 'POST', '/staff/inbox/bulk-approve', {
        token: manager(),
        body: {
          items: [
            { type: 'unit_permit', id: '0193b8a4-0000-7000-8000-000000000000' },
          ],
        },
      }),
    'GET /staff/inbox/settings': () =>
      call(world(), 'GET', '/staff/inbox/settings', { token: manager() }),
    'PATCH /staff/inbox/settings': () =>
      call(world(), 'PATCH', '/staff/inbox/settings', {
        token: manager(),
        body: { items: [{ type: 'vehicle', dueHours: 48 }] },
      }),
  };
}
