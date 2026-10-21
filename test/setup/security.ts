import { newId } from '../../src/core/common/uuid';
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
  scheduledStart: string | null;
  scheduledEnd: string | null;
  lateMinutes: number | null;
  pendingHandovers: number;
}

export interface SlotBody {
  id: string;
  guard?: { id: string; fullName?: string | null };
  post: {
    gateId: string | null;
    gateName: string | null;
    zone: PlaceBody | null;
  };
  startsAt: string;
  endsAt: string;
  status: 'scheduled' | 'cancelled';
  cancelReason: string | null;
  shift: {
    id: string;
    startedAt: string;
    endedAt: string | null;
    overtimeMinutes: number | null;
  } | null;
  lateMinutes: number | null;
  late: boolean;
  absentAt: string | null;
  swappedAt: string | null;
  templateId?: string | null;
}

export interface TemplateBody {
  id: string;
  guard: { id: string; fullName?: string | null };
  post: SlotBody['post'];
  schedule: { days: number[]; windows: { from: string; to: string }[] };
  effectiveFrom: string;
  effectiveUntil: string | null;
  endedAt: string | null;
  endReason: string | null;
  createdAt: string;
}

const MINUTE = 60_000;

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

  /** `POST /staff/security/roster/slots` as `as`. */
  function slotRaw(
    as: Who,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    return v.http(
      'post',
      '/staff/security/roster/slots',
      as.token,
      body,
      headers,
    );
  }

  /** A single slot that must be made: its body. */
  async function slot(
    as: Who,
    guardId: string,
    post: { gateId?: string; zoneId?: string },
    startsInMinutes: number,
    lastsMinutes = 480,
  ): Promise<SlotBody> {
    const startsAt = new Date(Date.now() + startsInMinutes * MINUTE);
    const res = await slotRaw(as, {
      guardId,
      ...post,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(
        startsAt.getTime() + lastsMinutes * MINUTE,
      ).toISOString(),
    });
    if (res.status !== 201)
      throw new Error(`slot: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as SlotBody;
  }

  /** `POST /staff/security/roster/templates` as `as`. */
  function templateRaw(
    as: Who,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    return v.http(
      'post',
      '/staff/security/roster/templates',
      as.token,
      body,
      headers,
    );
  }

  /**
   * A slot row written as it would have been in the past (the API makes
   * future slots only): `startsAgo` minutes before now, `lasts` long, made
   * a day before its start (`extra.createdAt` to make it later).
   */
  function pastSlot(
    c: Compound,
    guardId: string,
    post: { gateId?: string; placeId?: string },
    startsAgo: number,
    lasts = 480,
    extra: Record<string, unknown> = {},
  ) {
    const startsAt = new Date(Date.now() - startsAgo * MINUTE);
    return v.inTx(c, (tx) =>
      tx.guardRosterSlot.create({
        data: {
          id: newId(),
          tenantId: c.tenantId,
          guardAccountId: guardId,
          gateId: post.gateId ?? null,
          placeId: post.placeId ?? null,
          startsAt,
          endsAt: new Date(startsAt.getTime() + lasts * MINUTE),
          createdById: c.managerId,
          // eslint-disable-next-line no-restricted-syntax -- any instant before the start: only its order with the start counts
          createdAt: new Date(startsAt.getTime() - 24 * 60 * MINUTE),
          ...extra,
        },
      }),
    );
  }

  /** A slot's row. */
  function slotRow(c: Compound, id: string) {
    return v.inTx(c, (tx) =>
      tx.guardRosterSlot.findUniqueOrThrow({ where: { id } }),
    );
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
    slotRaw,
    slot,
    templateRaw,
    pastSlot,
    slotRow,
  };
}
