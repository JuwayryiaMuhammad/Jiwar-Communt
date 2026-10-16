import type { Response } from 'supertest';
import {
  addDays,
  localDate,
  zonedInstant,
} from '../../src/core/common/slots/day-slots';
import { call } from './request';
import type { World } from './world';

const ZONE = 'Africa/Cairo';

/**
 * A real call for each of the guards' duty routes (ADR 0050), as A's
 * manager or A's guard. Each write takes a time of its own on A's guard's
 * roster, so no call answers ROSTER_OVERLAP instead.
 */
export function guardDutyCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const manager = (method: 'GET' | 'POST', path: string, payload?: object) =>
    call(world(), method, path, {
      token: world().a.tokens.manager,
      body: payload,
    });
  const guard = (method: 'GET' | 'POST', path: string, payload?: object) =>
    call(world(), method, path, {
      token: world().a.tokens.guard,
      body: payload,
    });
  const today = () => localDate(new Date(), ZONE);
  /** A template of A's guard on one weekday, at 04:00 for an hour. */
  const template = (weekday: number) =>
    manager('POST', '/staff/security/roster/templates', {
      guardId: world().a.ids.guard,
      gateId: world().a.gateId,
      schedule: { days: [weekday], windows: [{ from: '04:00', to: '05:00' }] },
      effectiveFrom: addDays(today(), 1),
    });
  /** A single slot of A's guard, `days` ahead at noon for an hour. */
  const slot = (days: number) => {
    const startsAt = zonedInstant(addDays(today(), days), 12 * 60, ZONE)!;
    return manager('POST', '/staff/security/roster/slots', {
      guardId: world().a.ids.guard,
      gateId: world().a.gateId,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
    });
  };
  const id = (res: Response) => (res.body as { id: string }).id;
  return {
    'GET /staff/security/posts': () => manager('GET', '/staff/security/posts'),
    'GET /staff/security/guards': () =>
      manager('GET', '/staff/security/guards'),
    'POST /staff/security/roster/templates': () => template(3),
    'GET /staff/security/roster/templates': () =>
      manager('GET', '/staff/security/roster/templates'),
    'POST /staff/security/roster/templates/{id}/end': async () =>
      manager(
        'POST',
        `/staff/security/roster/templates/${id(await template(4))}/end`,
      ),
    'POST /staff/security/roster/slots': () => slot(3),
    'GET /staff/security/roster/slots': () =>
      manager('GET', '/staff/security/roster/slots'),
    'POST /staff/security/roster/slots/{id}/cancel': async () =>
      manager(
        'POST',
        `/staff/security/roster/slots/${id(await slot(5))}/cancel`,
        { reasonCode: 'other' },
      ),
    'GET /staff/security/attendance': () =>
      manager('GET', '/staff/security/attendance'),
    'GET /gate/roster': () => guard('GET', '/gate/roster'),
    'GET /gate/roster/attendance': () =>
      guard('GET', '/gate/roster/attendance'),
  };
}
