import type { Response } from 'supertest';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each of the patrol routes (ADR 0052), as A's manager or
 * A's guard (on shift at A's gate).
 */
export function patrolCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const manager = (
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    payload?: object,
  ) =>
    call(world(), method, path, {
      token: world().a.tokens.manager,
      body: payload,
    });
  const id = (res: Response) => (res.body as { id: string }).id;
  let n = 0;
  /** A checkpoint at A's gate: its id. */
  const aCheckpoint = async () =>
    id(
      await manager('POST', '/staff/security/patrols/checkpoints', {
        gateId: world().a.gateId,
        nameEn: `No-store point ${++n} ${Date.now()}`,
        nameAr: `نقطة ${n} ${Date.now()}`,
      }),
    );
  return {
    'GET /staff/security/patrols/checkpoints': () =>
      manager('GET', '/staff/security/patrols/checkpoints'),
    'POST /staff/security/patrols/checkpoints': async () =>
      manager('POST', '/staff/security/patrols/checkpoints', {
        gateId: world().a.gateId,
        nameEn: `No-store fence ${Date.now()}`,
        nameAr: `سور ${Date.now()}`,
      }),
    'PATCH /staff/security/patrols/checkpoints/{id}': async () =>
      manager(
        'PATCH',
        `/staff/security/patrols/checkpoints/${await aCheckpoint()}`,
        { position: { lat: 30, lng: 31 } },
      ),
    'POST /staff/security/patrols/checkpoints/{id}/reissue': async () =>
      manager(
        'POST',
        `/staff/security/patrols/checkpoints/${await aCheckpoint()}/reissue`,
      ),
    'POST /staff/security/patrols/checkpoints/{id}/retire': async () =>
      manager(
        'POST',
        `/staff/security/patrols/checkpoints/${await aCheckpoint()}/retire`,
      ),
  };
}
