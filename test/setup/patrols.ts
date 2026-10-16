import { newId } from '../../src/core/common/uuid';
import type { Compound } from './community';
import { uniqueSuffix } from './fixtures';
import type { HttpHarness } from './http-app';
import { securityHelpers, type Who } from './security';
import type { PlaceBody } from './safety';

export type { Who } from './security';

export interface PostBody {
  gateId: string | null;
  gateName: string | null;
  zone: PlaceBody | null;
}

export interface CheckpointBody {
  id: string;
  post: PostBody;
  nameEn: string;
  nameAr: string;
  position: { lat: number; lng: number; radiusM: number } | null;
  tokenIssuedAt: string;
  retiredAt: string | null;
  createdAt: string;
  qrPayload?: string;
}

export interface RouteBody {
  id: string;
  post: PostBody;
  nameEn: string;
  nameAr: string;
  version: {
    id: string;
    number: number;
    ordered: boolean;
    expectedMinutes: number;
    windowMinutes: number;
    schedule: { days: number[]; times: string[] } | null;
    checkpoints: number;
    createdAt: string;
  };
  retiredAt: string | null;
  createdAt: string;
  stops?: {
    position: number;
    checkpointId: string;
    nameEn: string;
    nameAr: string;
    location: { lat: number; lng: number; radiusM: number } | null;
    retired: boolean;
  }[];
}

export interface RunBody {
  id: string;
  route: { id: string; nameEn: string; nameAr: string };
  post: PostBody;
  kind: 'scheduled' | 'adhoc';
  status: string;
  plannedAt: string;
  scheduledStart: string | null;
  windowEndsAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  late: boolean;
  checkpointsTotal: number;
  scannedCount: number;
  guard: {
    id: string;
    firstName?: string | null;
    fullName?: string | null;
    erased?: true;
  } | null;
  cancelReason?: string | null;
  ordered?: boolean;
  expectedMinutes?: number;
  timesOutAt?: string | null;
  stops?: { position: number; checkpointId: string }[];
}

const MINUTE = 60_000;

/**
 * Helpers for the patrol suites (ADR 0052), on top of the guard duty ones:
 * checkpoints, routes and runs over HTTP.
 */
export function patrolHelpers(h: HttpHarness) {
  const x = securityHelpers(h);

  /** `POST /staff/security/patrols/checkpoints` as `as`. */
  function checkpointRaw(as: Who, body: Record<string, unknown>) {
    return x.http('post', '/staff/security/patrols/checkpoints', as.token, {
      nameEn: `Point ${uniqueSuffix()}`,
      nameAr: `نقطة ${uniqueSuffix()}`,
      ...body,
    });
  }

  /** A checkpoint that must be made, with its payload (shown once). */
  async function checkpoint(
    as: Who,
    post: { gateId?: string; zoneId?: string },
    over: Record<string, unknown> = {},
  ): Promise<CheckpointBody & { qrPayload: string }> {
    const res = await checkpointRaw(as, { ...post, ...over });
    if (res.status !== 201)
      throw new Error(`checkpoint: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as CheckpointBody & { qrPayload: string };
  }

  /** `POST /staff/security/patrols/routes` as `as`. */
  function routeRaw(
    as: Who,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    return x.http(
      'post',
      '/staff/security/patrols/routes',
      as.token,
      {
        nameEn: `Round ${uniqueSuffix()}`,
        nameAr: `جولة ${uniqueSuffix()}`,
        ...body,
      },
      headers,
    );
  }

  /** A route that must be made, from `post`, walking `checkpointIds`. */
  async function route(
    as: Who,
    post: { gateId?: string; zoneId?: string },
    checkpointIds: string[],
    version: Record<string, unknown> = {},
  ): Promise<RouteBody> {
    const res = await routeRaw(as, {
      ...post,
      version: {
        checkpointIds,
        ordered: false,
        expectedMinutes: 30,
        ...version,
      },
    });
    if (res.status !== 201)
      throw new Error(`route: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as RouteBody;
  }

  /** `POST /staff/security/patrols/routes/:id/versions` as `as`. */
  function versionRaw(as: Who, routeId: string, body: Record<string, unknown>) {
    return x.http(
      'post',
      `/staff/security/patrols/routes/${routeId}/versions`,
      as.token,
      body,
    );
  }

  /**
   * A scheduled run row of the route's current version, as the sweep would
   * have made it: its start `startsAgo` minutes before now (negative: to
   * come), its window as the route says.
   */
  function runRow(
    c: Compound,
    r: RouteBody,
    startsAgo: number,
    windowMinutes = r.version.windowMinutes,
  ) {
    const scheduledStart = new Date(Date.now() - startsAgo * MINUTE);
    return x.inTx(c, (tx) =>
      tx.patrolRun.create({
        data: {
          id: newId(),
          tenantId: c.tenantId,
          routeId: r.id,
          versionId: r.version.id,
          gateId: r.post.gateId,
          placeId: r.post.zone?.id ?? null,
          kind: 'scheduled',
          plannedAt: scheduledStart,
          scheduledStart,
          windowEndsAt: new Date(
            scheduledStart.getTime() + windowMinutes * MINUTE,
          ),
          status: 'scheduled',
          checkpointsTotal: r.version.checkpoints,
        },
      }),
    );
  }

  /** A run's row now. */
  function runOf(c: Compound, id: string) {
    return x.inTx(c, (tx) => tx.patrolRun.findUniqueOrThrow({ where: { id } }));
  }

  /** `POST /gate/patrols/runs/:id/start` as `as`. */
  function startRunRaw(
    as: Who,
    id: string,
    headers: Record<string, string> = {},
  ) {
    return x.http(
      'post',
      `/gate/patrols/runs/${id}/start`,
      as.token,
      {},
      headers,
    );
  }

  /** `POST /gate/patrols/routes/:id/start` as `as`. */
  function adhocRaw(
    as: Who,
    routeId: string,
    headers: Record<string, string> = {},
  ) {
    return x.http(
      'post',
      `/gate/patrols/routes/${routeId}/start`,
      as.token,
      {},
      headers,
    );
  }

  /** A run of `as`'s own that must start: its body. */
  async function adhoc(as: Who, routeId: string): Promise<RunBody> {
    const res = await adhocRaw(as, routeId);
    if (res.status !== 201)
      throw new Error(`adhoc: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as RunBody;
  }

  /** `POST /gate/patrols/runs/:id/end` as `as`. */
  function endRunRaw(as: Who, id: string) {
    return x.http('post', `/gate/patrols/runs/${id}/end`, as.token);
  }

  /** `POST /gate/patrols/runs/:id/scans` as `as`; a fresh id unless given. */
  function scanRaw(as: Who, runId: string, body: Record<string, unknown>) {
    return x.http('post', `/gate/patrols/runs/${runId}/scans`, as.token, {
      id: newId(),
      scannedAt: new Date().toISOString(),
      ...body,
    });
  }

  /** `POST /gate/patrols/runs/:id/notes` as `as`. */
  function noteRaw(as: Who, runId: string, body: Record<string, unknown>) {
    return x.http('post', `/gate/patrols/runs/${runId}/notes`, as.token, {
      id: newId(),
      notedAt: new Date().toISOString(),
      outcome: 'all_clear',
      ...body,
    });
  }

  return {
    ...x,
    x,
    scanRaw,
    noteRaw,
    checkpointRaw,
    checkpoint,
    routeRaw,
    route,
    versionRaw,
    runRow,
    runOf,
    startRunRaw,
    adhocRaw,
    adhoc,
    endRunRaw,
  };
}
