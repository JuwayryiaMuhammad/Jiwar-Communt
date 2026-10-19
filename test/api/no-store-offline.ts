import type { Response } from 'supertest';
import { enrolMessage } from '../../src/gate/offline/device-envelope';
import { newId } from '../../src/core/common/uuid';
import {
  envelope,
  newDevice,
  readBundle,
  signAs,
  type SignedBundle,
} from '../setup/offline';
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
  /**
   * A batch of one action on a subject nobody knows, from a device of A's
   * with its bundle: rejected and flagged (quarantined when `revoked`).
   * The answer.
   */
  const uploaded = async (revoked = false) => {
    const d = await device();
    const signed = (
      await guard(
        'POST',
        '/gate/offline/bundles',
        envelope(d, world().a.tenantId, 'bundle'),
      )
    ).body as SignedBundle;
    const b = readBundle(signed);
    if (revoked)
      await manager('POST', `/staff/gate/devices/${d.id}/revoke`, {
        reasonCode: 'lost',
      });
    return guard(
      'POST',
      '/gate/offline/uploads',
      envelope(d, world().a.tenantId, 'upload', {
        batchId: newId(),
        actions: [
          {
            clientId: newId(),
            seq: d.seq++,
            deviceTime: b.issuedAt,
            bundleId: b.bundleId,
            type: 'entry',
            subjectType: 'visitor_pass',
            subjectId: newId(),
            direction: 'in',
            via: 'code',
          },
        ],
      }),
    );
  };
  /** A flag of A's: its id. */
  const flagged = async (): Promise<string> => {
    const up = (await uploaded()).body as { batchId: string };
    const list = (await manager('GET', '/staff/gate/offline/flags?status=open'))
      .body as { data: { id: string; batchId: string }[] };
    return list.data.find((f) => f.batchId === up.batchId)!.id;
  };
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
    'POST /gate/offline/uploads': () => uploaded(),
    'POST /gate/offline/heartbeat': async () =>
      guard(
        'POST',
        '/gate/offline/heartbeat',
        envelope(await device(), world().a.tenantId, 'heartbeat', {
          pendingCount: 0,
        }),
      ),
    'GET /staff/gate/offline/batches': () =>
      manager('GET', '/staff/gate/offline/batches'),
    'GET /staff/gate/offline/batches/{id}': async () =>
      manager(
        'GET',
        `/staff/gate/offline/batches/${((await uploaded()).body as { batchId: string }).batchId}`,
      ),
    'POST /staff/gate/offline/batches/{id}/review': async () =>
      manager(
        'POST',
        `/staff/gate/offline/batches/${((await uploaded(true)).body as { batchId: string }).batchId}/review`,
        { decision: 'reject' },
      ),
    'GET /staff/gate/offline/flags': () =>
      manager('GET', '/staff/gate/offline/flags'),
    'GET /staff/gate/offline/flags/{id}': async () =>
      manager('GET', `/staff/gate/offline/flags/${await flagged()}`),
    'POST /staff/gate/offline/flags/{id}/review': async () =>
      manager('POST', `/staff/gate/offline/flags/${await flagged()}/review`, {
        reviewCode: 'false_alarm',
      }),
    'POST /staff/gate/devices/{id}/revoke': async () =>
      manager('POST', `/staff/gate/devices/${await enrolled()}/revoke`, {
        reasonCode: 'retired',
      }),
  };
}
