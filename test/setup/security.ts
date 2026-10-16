import type { Compound } from './community';
import type { HttpHarness } from './http-app';
import { safetyHelpers, type PlaceBody, type Who } from './safety';

export type { Who } from './safety';

export interface ShiftBody {
  id: string;
  gateId: string | null;
  gateName: string | null;
  zone: PlaceBody | null;
  startedAt: string;
  endedAt: string | null;
}

/**
 * Helpers for the guard shifts and tasks suites (ADR 0050), on top of the
 * safety ones: guards with or without a shift, at a gate or in a zone, the
 * security supervisor, and calls over HTTP.
 */
export function securityHelpers(h: HttpHarness) {
  const s = safetyHelpers(h);
  const { v, g } = s;

  /** A guard account with no shift yet. */
  async function guard(c: Compound): Promise<Who> {
    return v.who(c, (await g.guard(c)).id, 'staff');
  }

  /** An account of the default security supervisor role. */
  async function supervisor(c: Compound): Promise<Who> {
    return v.who(c, (await g.guard(c, 'security_supervisor')).id, 'staff');
  }

  /** `POST /gate/shifts/start` as `as`. */
  function startRaw(
    as: Who,
    body: { gateId?: string; zoneId?: string },
    headers: Record<string, string> = {},
  ) {
    return v.http('post', '/gate/shifts/start', as.token, body, headers);
  }

  /** A shift that must open: its body. */
  async function start(
    as: Who,
    body: { gateId?: string; zoneId?: string },
  ): Promise<ShiftBody> {
    const res = await startRaw(as, body);
    if (res.status !== 201)
      throw new Error(`start: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as ShiftBody;
  }

  /** `POST /gate/shifts/end` as `as`. */
  function endRaw(
    as: Who,
    body: object = {},
    headers: Record<string, string> = {},
  ) {
    return v.http('post', '/gate/shifts/end', as.token, body, headers);
  }

  /** The guard's shift row. */
  function shiftRow(c: Compound, id: string) {
    return v.inTx(c, (tx) =>
      tx.guardShift.findUniqueOrThrow({ where: { id } }),
    );
  }

  return {
    ...s,
    s,
    guard,
    supervisor,
    startRaw,
    start,
    endRaw,
    shiftRow,
  };
}
