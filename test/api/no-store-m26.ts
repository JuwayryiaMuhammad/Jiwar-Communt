import type { Response } from 'supertest';
import { dbClock, day } from '../setup/compound-clock';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of compliance and safety (ADR 0087),
 * in A: the status report and its CSV, an incident's corrective actions,
 * the owner's own list, the safety KPIs, and a lockdown from the office
 * (ended at once, so A's gates stay open for the other calls).
 */
export function m26Calls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const manager = () => world().a.tokens.manager;
  const technician = () => world().a.tokens.technician;
  const incident = async (): Promise<string> =>
    (
      (
        await call(world(), 'POST', '/staff/security/incidents', {
          token: manager(),
          body: {
            type: 'hazard',
            severity: 'low',
            unitCode: world().a.homeUnitCode,
            occurredAt: new Date(dbClock().getTime() - 60_000).toISOString(),
            description: 'No-store hazard',
          },
        }).expect(201)
      ).body as { id: string }
    ).id;
  const action = async (ownerId = world().a.ids.technician) => {
    const id = await incident();
    return (
      (
        await call(world(), 'POST', `/staff/security/incidents/${id}/actions`, {
          token: manager(),
          body: { description: 'No-store action', ownerId, dueOn: day(5) },
        }).expect(201)
      ).body as { id: string }
    ).id;
  };
  return {
    'GET /staff/compliance/report': () =>
      call(world(), 'GET', '/staff/compliance/report', { token: manager() }),
    'GET /staff/compliance/report/export': () =>
      call(world(), 'GET', '/staff/compliance/report/export', {
        token: manager(),
      }),
    'GET /staff/security/incidents/{id}/actions': async () =>
      call(
        world(),
        'GET',
        `/staff/security/incidents/${await incident()}/actions`,
        { token: manager() },
      ),
    'POST /staff/security/incidents/{id}/actions': async () =>
      call(
        world(),
        'POST',
        `/staff/security/incidents/${await incident()}/actions`,
        {
          token: manager(),
          body: {
            description: 'No-store action',
            ownerId: world().a.ids.technician,
            dueOn: day(5),
          },
        },
      ),
    'PATCH /staff/security/incident-actions/{actionId}': async () =>
      call(
        world(),
        'PATCH',
        `/staff/security/incident-actions/${await action()}`,
        { token: manager(), body: { dueOn: day(6) } },
      ),
    'POST /staff/security/incident-actions/{actionId}/done': async () =>
      call(
        world(),
        'POST',
        `/staff/security/incident-actions/${await action()}/done`,
        { token: manager(), body: {} },
      ),
    'POST /staff/security/incident-actions/{actionId}/cancel': async () =>
      call(
        world(),
        'POST',
        `/staff/security/incident-actions/${await action()}/cancel`,
        { token: manager(), body: { reasonCode: 'not_needed' } },
      ),
    'GET /staff/incident-actions': () =>
      call(world(), 'GET', '/staff/incident-actions', { token: technician() }),
    'POST /staff/incident-actions/{actionId}/done': async () =>
      call(world(), 'POST', `/staff/incident-actions/${await action()}/done`, {
        token: technician(),
        body: {},
      }),
    'GET /staff/security/reports/safety': () =>
      call(world(), 'GET', '/staff/security/reports/safety', {
        token: manager(),
      }),
    'POST /staff/security/lockdowns': async () => {
      const res = await call(world(), 'POST', '/staff/security/lockdowns', {
        token: manager(),
        body: {
          scope: 'all',
          reasonCode: 'drill',
          confirmation: 'LOCKDOWN',
        },
      });
      await call(
        world(),
        'POST',
        `/staff/security/lockdowns/${(res.body as { id: string }).id}/end`,
        { token: manager(), body: { reasonCode: 'drill_over' } },
      ).expect(200);
      return res;
    },
  };
}
