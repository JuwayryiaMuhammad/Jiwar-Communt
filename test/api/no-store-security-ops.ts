import type { Response } from 'supertest';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each of the security routes of ADR 0053, as A's guard (on
 * shift at A's gate) or A's manager. Every lockdown is ended before the
 * call returns: A's gate stays open for the other calls.
 */
export function securityOpsCalls(
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
  const guard = (method: 'GET' | 'POST', path: string, payload?: object) =>
    call(world(), method, path, {
      token: world().a.tokens.guard,
      body: payload,
    });
  const id = (res: Response) => (res.body as { id: string }).id;
  const start = () =>
    guard('POST', '/gate/lockdowns', {
      scope: 'gate',
      gateId: world().a.gateId,
      reasonCode: 'drill',
      confirmation: 'LOCKDOWN',
    });
  const end = (lockdownId: string) =>
    manager('POST', `/staff/security/lockdowns/${lockdownId}/end`, {
      reasonCode: 'drill_over',
    });
  /** `fn` with a lockdown of A's gate live, ended afterwards. */
  const during = async (
    fn: (lockdownId: string) => Promise<Response>,
  ): Promise<Response> => {
    const lockdownId = id(await start());
    try {
      return await fn(lockdownId);
    } finally {
      await end(lockdownId);
    }
  };
  let n = 0;
  /** A plate A bans: its id. */
  const aEntry = async () =>
    id(
      await manager('POST', '/staff/security/blocklist', {
        kind: 'watch',
        subject: 'plate',
        plate: `NS ${++n}${Date.now() % 1000}`,
        reasonCode: 'other',
      }),
    );
  return {
    'GET /staff/security/blocklist': () =>
      manager('GET', '/staff/security/blocklist'),
    'POST /staff/security/blocklist': () =>
      manager('POST', '/staff/security/blocklist', {
        kind: 'watch',
        subject: 'plate',
        plate: `NS ${++n}${Date.now() % 1000}`,
        reasonCode: 'other',
      }),
    'GET /staff/security/blocklist/{id}': async () =>
      manager('GET', `/staff/security/blocklist/${await aEntry()}`),
    'PATCH /staff/security/blocklist/{id}': async () =>
      manager('PATCH', `/staff/security/blocklist/${await aEntry()}`, {
        kind: 'watch',
      }),
    'POST /staff/security/blocklist/{id}/lift': async () =>
      manager('POST', `/staff/security/blocklist/${await aEntry()}/lift`, {
        reasonCode: 'resolved',
      }),
    'GET /gate/blocklist': () => guard('GET', '/gate/blocklist'),
    'GET /staff/security/blocklist/{id}/matches': async () =>
      manager('GET', `/staff/security/blocklist/${await aEntry()}/matches`),
    'POST /gate/id-lookup': () =>
      guard('POST', '/gate/id-lookup', { idNumber: 'NS0000001' }),
    'POST /gate/lockdowns': async () => {
      const res = await start();
      await end(id(res));
      return res;
    },
    'GET /gate/lockdowns/active': () => guard('GET', '/gate/lockdowns/active'),
    'POST /gate/lockdowns/{id}/overrides': () =>
      during((lockdownId) =>
        guard('POST', `/gate/lockdowns/${lockdownId}/overrides`, {
          reasonCode: 'ambulance',
        }),
      ),
    'GET /staff/security/lockdowns': () =>
      manager('GET', '/staff/security/lockdowns'),
    'GET /staff/security/lockdowns/{id}': () =>
      during((lockdownId) =>
        manager('GET', `/staff/security/lockdowns/${lockdownId}`),
      ),
    'POST /staff/security/lockdowns/{id}/end': async () =>
      end(id(await start())),
  };
}
