import type { Response } from 'supertest';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each of the routes of ADR 0056, as A's guard (on shift at
 * A's gate) or A's manager.
 */
export function gateCompletionCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const as =
    (who: 'manager' | 'guard') =>
    (method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object) =>
      call(world(), method, path, {
        token: world().a.tokens[who],
        body: payload,
      });
  const manager = as('manager');
  const guard = as('guard');
  const id = (res: Response) => (res.body as { id: string }).id;
  /** A visitor's exception A's guard raises at A's gate: its id. */
  const raise = () =>
    guard('POST', '/gate/field-exceptions', {
      kind: 'visitor_without_pass',
      reasonCode: 'resident_unreachable',
      unitCode: world().a.homeUnitCode,
    });
  let plates = 0;
  /** A tanker A's guard lets in: a plate no other call uses. */
  const enter = () =>
    guard('POST', '/gate/service-vehicles', {
      plate: `NS ${1000 + ++plates}`,
      kind: 'tanker',
      company: 'No Store Water',
    });
  return {
    'POST /gate/service-vehicles': enter,
    'POST /gate/service-vehicles/{id}/exit': async () =>
      guard('POST', `/gate/service-vehicles/${id(await enter())}/exit`),
    'GET /gate/service-vehicles': () => guard('GET', '/gate/service-vehicles'),
    'GET /staff/gate/service-vehicles': () =>
      manager('GET', '/staff/gate/service-vehicles'),
    'GET /staff/gate/settings': () => manager('GET', '/staff/gate/settings'),
    'PATCH /staff/gate/settings': () =>
      manager('PATCH', '/staff/gate/settings', { exceptionAnswerMinutes: 10 }),
    'POST /gate/field-exceptions': raise,
    'GET /gate/field-exceptions/{id}': async () =>
      guard('GET', `/gate/field-exceptions/${id(await raise())}`),
    'POST /gate/field-exceptions/{id}/withdraw': async () =>
      guard('POST', `/gate/field-exceptions/${id(await raise())}/withdraw`),
    'GET /staff/gate/field-exceptions': () =>
      manager('GET', '/staff/gate/field-exceptions'),
    'GET /staff/gate/field-exceptions/{id}': async () =>
      manager('GET', `/staff/gate/field-exceptions/${id(await raise())}`),
    'POST /staff/gate/field-exceptions/{id}/decide': async () =>
      manager(
        'POST',
        `/staff/gate/field-exceptions/${id(await raise())}/decide`,
        {
          decision: 'reject',
          reasonCode: 'other',
        },
      ),
  };
}
