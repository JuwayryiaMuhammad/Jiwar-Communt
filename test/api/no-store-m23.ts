import type { Response } from 'supertest';
import { daysLater } from '../setup/compound-clock';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of the staff inbox, the board's
 * authorizations and the deputies (ADR 0073), in A, as its manager. A
 * deputyship is A's manager's for A's technician, ended before the next.
 */
export function m23Calls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const manager = () => world().a.tokens.manager;
  /** Ends the manager's live deputyship, if any: one live at a time. */
  const clear = async (): Promise<void> => {
    const mine = (
      (
        await call(world(), 'GET', '/staff/deputies', {
          token: manager(),
        }).expect(200)
      ).body as { data: { id: string; live: boolean; role: string }[] }
    ).data;
    for (const d of mine)
      if (d.live && d.role === 'principal')
        await call(world(), 'POST', `/staff/deputies/${d.id}/end`, {
          token: manager(),
        }).expect(200);
  };
  const appoint = () =>
    call(world(), 'POST', '/staff/deputies', {
      token: manager(),
      body: {
        deputyAccountId: world().a.ids.technician,
        permissions: ['permits.manage'],
        endsAt: daysLater(1).toISOString(),
      },
    });
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
    'GET /staff/finance/board-authorizations': () =>
      call(world(), 'GET', '/staff/finance/board-authorizations', {
        token: manager(),
      }),
    'GET /staff/deputies': () =>
      call(world(), 'GET', '/staff/deputies', { token: manager() }),
    // Ended after: the manager keeps permits.manage for every other call.
    'POST /staff/deputies': async () => {
      await clear();
      const res = await appoint();
      await clear();
      return res;
    },
    'POST /staff/deputies/{id}/end': async () => {
      await clear();
      const d = (await appoint().expect(201)).body as { id: string };
      return call(world(), 'POST', `/staff/deputies/${d.id}/end`, {
        token: manager(),
      });
    },
  };
}
