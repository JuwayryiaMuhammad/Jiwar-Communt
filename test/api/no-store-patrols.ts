import type { Response } from 'supertest';
import { newId } from '../../src/core/common/uuid';
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
  const guard = (method: 'GET' | 'POST', path: string, payload?: object) =>
    call(world(), method, path, {
      token: world().a.tokens.guard,
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
  /** A route from A's gate walking a new checkpoint: its id. */
  const aRoute = async () =>
    id(
      await manager('POST', '/staff/security/patrols/routes', {
        gateId: world().a.gateId,
        nameEn: `No-store round ${++n} ${Date.now()}`,
        nameAr: `جولة ${n} ${Date.now()}`,
        version: {
          checkpointIds: [await aCheckpoint()],
          ordered: true,
          expectedMinutes: 20,
        },
      }),
    );
  /** A's guard has no run under way: the next start may happen. */
  const clearLive = async () => {
    const w = world();
    const live = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.patrolRun.findFirst({
        where: { guardAccountId: w.a.ids.guard, status: 'in_progress' },
      }),
    );
    if (live) await guard('POST', `/gate/patrols/runs/${live.id}/end`);
  };
  /** A scheduled run at A's gate, `inMinutes` from now: its id. */
  const aRun = async (inMinutes: number) => {
    const w = world();
    const routeId = await aRoute();
    return w.helpers.asManager(w.a, async () => {
      const version =
        await w.helpers.prisma.tenant.patrolRouteVersion.findFirstOrThrow({
          where: { routeId, supersededAt: null },
        });
      const start = new Date(Date.now() + inMinutes * 60_000);
      const run = await w.helpers.prisma.tenant.patrolRun.create({
        data: {
          id: newId(),
          tenantId: w.a.tenantId,
          routeId,
          versionId: version.id,
          gateId: w.a.gateId,
          kind: 'scheduled',
          plannedAt: start,
          scheduledStart: start,
          windowEndsAt: new Date(start.getTime() + 30 * 60_000),
          status: 'scheduled',
          checkpointsTotal: 1,
        },
      });
      return run.id;
    });
  };
  return {
    'GET /gate/patrols': () => guard('GET', '/gate/patrols'),
    'GET /gate/patrols/runs': () => guard('GET', '/gate/patrols/runs'),
    'GET /gate/patrols/runs/{id}': async () =>
      guard('GET', `/gate/patrols/runs/${await aRun(60)}`),
    'POST /gate/patrols/runs/{id}/start': async () => {
      await clearLive();
      return guard('POST', `/gate/patrols/runs/${await aRun(0)}/start`);
    },
    'POST /gate/patrols/routes/{id}/start': async () => {
      await clearLive();
      return guard('POST', `/gate/patrols/routes/${await aRoute()}/start`);
    },
    'POST /gate/patrols/runs/{id}/scans': async () => {
      await clearLive();
      const route = await aRoute();
      const run = id(
        await guard('POST', `/gate/patrols/routes/${route}/start`),
      );
      const w = world();
      const stop = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.patrolRun.findUniqueOrThrow({
          where: { id: run },
        }),
      );
      const checkpointId = (
        await w.helpers.asManager(w.a, () =>
          w.helpers.prisma.tenant.patrolRouteCheckpoint.findFirstOrThrow({
            where: { versionId: stop.versionId },
          }),
        )
      ).checkpointId;
      return guard('POST', `/gate/patrols/runs/${run}/scans`, {
        id: newId(),
        method: 'manual',
        checkpointId,
        reasonCode: 'qr_missing',
        scannedAt: new Date().toISOString(),
      });
    },
    'POST /gate/patrols/runs/{id}/notes': async () => {
      await clearLive();
      const route = await aRoute();
      const run = id(
        await guard('POST', `/gate/patrols/routes/${route}/start`),
      );
      const w = world();
      const version = (
        await w.helpers.asManager(w.a, () =>
          w.helpers.prisma.tenant.patrolRun.findUniqueOrThrow({
            where: { id: run },
          }),
        )
      ).versionId;
      const checkpointId = (
        await w.helpers.asManager(w.a, () =>
          w.helpers.prisma.tenant.patrolRouteCheckpoint.findFirstOrThrow({
            where: { versionId: version },
          }),
        )
      ).checkpointId;
      const scan = id(
        await guard('POST', `/gate/patrols/runs/${run}/scans`, {
          id: newId(),
          method: 'manual',
          checkpointId,
          reasonCode: 'other',
          scannedAt: new Date().toISOString(),
        }),
      );
      return guard('POST', `/gate/patrols/runs/${run}/notes`, {
        id: newId(),
        scanId: scan,
        outcome: 'all_clear',
        notedAt: new Date().toISOString(),
      });
    },
    'POST /gate/patrols/runs/{id}/end': async () => {
      await clearLive();
      const run = id(
        await guard('POST', `/gate/patrols/routes/${await aRoute()}/start`),
      );
      return guard('POST', `/gate/patrols/runs/${run}/end`);
    },
    'GET /staff/security/patrols/runs': () =>
      manager('GET', '/staff/security/patrols/runs'),
    'GET /staff/security/patrols/runs/{id}': async () =>
      manager('GET', `/staff/security/patrols/runs/${await aRun(60)}`),
    'POST /staff/security/patrols/runs/{id}/cancel': async () =>
      manager('POST', `/staff/security/patrols/runs/${await aRun(60)}/cancel`, {
        reasonCode: 'other',
      }),
    'GET /staff/security/patrols/routes': () =>
      manager('GET', '/staff/security/patrols/routes'),
    'POST /staff/security/patrols/routes': async () =>
      manager('POST', '/staff/security/patrols/routes', {
        gateId: world().a.gateId,
        nameEn: `No-store walk ${Date.now()}`,
        nameAr: `مشي ${Date.now()}`,
        version: {
          checkpointIds: [await aCheckpoint()],
          ordered: false,
          expectedMinutes: 30,
        },
      }),
    'GET /staff/security/patrols/routes/{id}': async () =>
      manager('GET', `/staff/security/patrols/routes/${await aRoute()}`),
    'PATCH /staff/security/patrols/routes/{id}': async () =>
      manager('PATCH', `/staff/security/patrols/routes/${await aRoute()}`, {
        nameEn: `No-store renamed ${Date.now()}`,
      }),
    'POST /staff/security/patrols/routes/{id}/versions': async () =>
      manager(
        'POST',
        `/staff/security/patrols/routes/${await aRoute()}/versions`,
        {
          checkpointIds: [await aCheckpoint(), await aCheckpoint()],
          ordered: false,
          expectedMinutes: 25,
        },
      ),
    'POST /staff/security/patrols/routes/{id}/retire': async () =>
      manager(
        'POST',
        `/staff/security/patrols/routes/${await aRoute()}/retire`,
      ),
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
