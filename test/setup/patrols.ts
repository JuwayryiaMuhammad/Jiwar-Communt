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

  return { ...x, x, checkpointRaw, checkpoint };
}
