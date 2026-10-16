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

  return {
    ...x,
    x,
    checkpointRaw,
    checkpoint,
    routeRaw,
    route,
    versionRaw,
  };
}
