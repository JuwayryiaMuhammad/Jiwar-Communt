import type { Response } from 'supertest';
import { enrolMessage } from '../../src/gate/offline/device-envelope';
import { envelope, newDevice, signAs } from '../setup/offline';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each of the routes of ADR 0057, as A's guard (on shift at
 * A's gate) or A's manager.
 */
export function offlineCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const as =
    (who: 'manager' | 'guard') =>
    (method: 'GET' | 'POST', path: string, payload?: object) =>
      call(world(), method, path, {
        token: world().a.tokens[who],
        body: payload,
      });
  const manager = as('manager');
  const guard = as('guard');
  /** A device A's guard enrols. */
  const device = async () => {
    const d = newDevice();
    await guard('POST', '/gate/devices', {
      id: d.id,
      publicKey: d.publicKey,
      proof: signAs(d, enrolMessage(world().a.tenantId, d.id, d.publicKey)),
    });
    return d;
  };
  const enrolled = async (): Promise<string> => (await device()).id;
  return {
    'POST /gate/devices': async () => {
      const d = newDevice();
      return guard('POST', '/gate/devices', {
        id: d.id,
        publicKey: d.publicKey,
        proof: signAs(d, enrolMessage(world().a.tenantId, d.id, d.publicKey)),
      });
    },
    'GET /staff/gate/devices': () => manager('GET', '/staff/gate/devices'),
    'GET /staff/gate/devices/{id}': async () =>
      manager('GET', `/staff/gate/devices/${await enrolled()}`),
    'GET /gate/offline/keys': () => guard('GET', '/gate/offline/keys'),
    'POST /gate/offline/bundles': async () =>
      guard(
        'POST',
        '/gate/offline/bundles',
        envelope(await device(), world().a.tenantId, 'bundle'),
      ),
    'POST /staff/gate/devices/{id}/revoke': async () =>
      manager('POST', `/staff/gate/devices/${await enrolled()}/revoke`, {
        reasonCode: 'retired',
      }),
  };
}
