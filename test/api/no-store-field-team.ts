import type { Response } from 'supertest';
import { addDays } from '../../src/core/common/slots/day-slots';
import { at, today } from '../setup/compound-clock';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each of the field team's routes (ADR 0078), as A's
 * manager or A's technician. Each write takes a time of its own on A's
 * technician's roster, so no call answers ROSTER_OVERLAP instead.
 */
export function fieldTeamCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const manager = (method: 'GET' | 'POST', path: string, payload?: object) =>
    call(world(), method, path, {
      token: world().a.tokens.manager,
      body: payload,
    });
  const technician = (method: 'GET' | 'POST', path: string, payload?: object) =>
    call(world(), method, path, {
      token: world().a.tokens.technician,
      body: payload,
    });
  /** A template of A's technician on one weekday, at 04:00 for an hour. */
  const template = (weekday: number) =>
    manager('POST', '/staff/field-team/roster/templates', {
      technicianId: world().a.ids.technician,
      schedule: { days: [weekday], windows: [{ from: '04:00', to: '05:00' }] },
      effectiveFrom: addDays(today(), 1),
    });
  /** A single slot of A's technician, `days` ahead at noon for an hour. */
  const slot = (days: number) => {
    const startsAt = at(addDays(today(), days), 12);
    return manager('POST', '/staff/field-team/roster/slots', {
      technicianId: world().a.ids.technician,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
    });
  };
  const id = (res: Response) => (res.body as { id: string }).id;
  return {
    'GET /staff/field-team/technicians': () =>
      manager('GET', '/staff/field-team/technicians'),
    'GET /staff/field-team/zones': () =>
      manager('GET', '/staff/field-team/zones'),
    'POST /staff/field-team/roster/templates': () => template(3),
    'GET /staff/field-team/roster/templates': () =>
      manager('GET', '/staff/field-team/roster/templates'),
    'POST /staff/field-team/roster/templates/{id}/end': async () =>
      manager(
        'POST',
        `/staff/field-team/roster/templates/${id(await template(4))}/end`,
      ),
    'POST /staff/field-team/roster/slots': () => slot(3),
    'GET /staff/field-team/roster/slots': () =>
      manager('GET', '/staff/field-team/roster/slots'),
    'POST /staff/field-team/roster/slots/{id}/cancel': async () =>
      manager(
        'POST',
        `/staff/field-team/roster/slots/${id(await slot(5))}/cancel`,
        { reasonCode: 'other' },
      ),
    'GET /staff/field-team/attendance': () =>
      manager('GET', '/staff/field-team/attendance'),
    'GET /maintenance/my-roster': () =>
      technician('GET', '/maintenance/my-roster'),
    'GET /maintenance/my-roster/attendance': () =>
      technician('GET', '/maintenance/my-roster/attendance'),
  };
}
