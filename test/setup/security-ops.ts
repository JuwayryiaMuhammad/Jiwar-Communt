import { createHmac } from 'node:crypto';
import type { Compound } from './community';
import type { HttpHarness } from './http-app';
import { securityHelpers } from './security';
import type { Who } from './vehicles';

export type { Who } from './vehicles';

/** An emergency as the responders see it (ADR 0047, 0053). */
export interface StaffEmergencyBody {
  id: string;
  reference: string;
  type: string;
  status: string;
  location: {
    unitId: string;
    unitCode: string;
    building: string | null;
  } | null;
  post: {
    gateId: string | null;
    gateName: string | null;
    zone: { id: string } | null;
  } | null;
  reportedBy: { id: string; firstName?: string | null };
  responderAccount: { id: string } | null;
  isMine: boolean;
  escalatedAt: string | null;
  escalationReason: string | null;
  respondersNotified: number;
  familyNotified: number;
  closeReason: string | null;
}

/** A lockdown as the guard sees it (ADR 0053). */
export interface LockdownBody {
  id: string;
  scope: 'gate' | 'all';
  gate: { id: string; name: string } | null;
  reasonCode: string;
  startedAt: string;
  startedBy: { id: string; firstName?: string | null };
}

/**
 * Helpers for the security suites of ADR 0053 — the guard's SOS, the
 * lockdown, the blocklist, stop work, incidents and violations — on top of
 * the guard duty ones: guards on shift at a gate or in a zone, and calls
 * over HTTP.
 */
export function securityOpsHelpers(h: HttpHarness) {
  const x = securityHelpers(h);

  /** A guard on an open shift in a zone: who, the zone and the shift. */
  async function guardInZone(
    c: Compound,
    zoneId: string,
  ): Promise<Who & { zoneId: string; shiftId: string }> {
    const guard = await x.guard(c);
    const shift = await x.start(guard, { zoneId });
    return { ...guard, zoneId, shiftId: shift.id };
  }

  /** A guard on an open shift at a given gate. */
  async function guardAt(
    c: Compound,
    gateId: string,
  ): Promise<Who & { gateId: string; shiftId: string }> {
    const guard = await x.guard(c);
    const shift = await x.start(guard, { gateId });
    return { ...guard, gateId, shiftId: shift.id };
  }

  /** `POST /gate/emergencies` (a guard's SOS) as `as`. */
  function sosRaw(
    as: Who,
    type = 'security',
    headers: Record<string, string> = {},
  ) {
    return x.http('post', '/gate/emergencies', as.token, { type }, headers);
  }

  /** An SOS that must make a new emergency: its body. */
  async function sos(as: Who, type = 'security'): Promise<StaffEmergencyBody> {
    const res = await sosRaw(as, type);
    if (res.status !== 201)
      throw new Error(`sos: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as StaffEmergencyBody;
  }

  /** `POST /gate/lockdowns` as `as` (the confirmation typed unless given). */
  function lockdownRaw(
    as: Who,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    return x.http(
      'post',
      '/gate/lockdowns',
      as.token,
      {
        scope: 'all',
        reasonCode: 'security_threat',
        confirmation: 'LOCKDOWN',
        ...body,
      },
      headers,
    );
  }

  /** A lockdown that must start: its body. */
  async function lockdown(
    as: Who,
    body: Record<string, unknown> = {},
  ): Promise<LockdownBody> {
    const res = await lockdownRaw(as, body);
    if (res.status !== 201)
      throw new Error(`lockdown: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as LockdownBody;
  }

  /** `POST /staff/security/lockdowns/:id/end` as `as`. */
  function endLockdownRaw(
    as: Who,
    id: string,
    body: Record<string, unknown> = { reasonCode: 'threat_cleared' },
  ) {
    return x.http(
      'post',
      `/staff/security/lockdowns/${id}/end`,
      as.token,
      body,
    );
  }

  /** `POST /gate/entries` as a guard: one person in (or out) on a subject. */
  function entryRaw(
    as: Who,
    subjectType: string,
    subjectId: string,
    over: Record<string, unknown> = {},
  ) {
    return x.http('post', '/gate/entries', as.token, {
      subjectType,
      subjectId,
      direction: 'in',
      ...over,
    });
  }

  /** `POST /gate/verify` with a pass's code (the guard's own budget). */
  function verifyRaw(as: Who, body: { code?: string; qr?: string }) {
    return x.http('post', '/gate/verify', as.token, body);
  }

  /** A visitor pass with its code, for verify and entries. */
  async function passWithCode(
    as: Who,
    unitId: string,
    over: Record<string, unknown> = {},
  ): Promise<{ id: string; code: string }> {
    const res = await x.http(
      'post',
      `/units/${unitId}/visitor-passes`,
      as.token,
      {
        kind: 'one_time',
        partySize: 2,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 6 * 3_600_000).toISOString(),
        ...over,
      },
    );
    if (res.status !== 201)
      throw new Error(`pass: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; code: string };
  }

  /** The resident's rotating entry QR for now (ADR 0031), from a fresh credential. */
  async function residentQr(as: Who): Promise<string> {
    const res = await x
      .http('post', '/me/entry-credentials', as.token, {})
      .expect(201);
    const c = res.body as { id: string; secret: string; stepSeconds: number };
    const step = Math.floor(Date.now() / (c.stepSeconds * 1000));
    const mac = createHmac('sha256', Buffer.from(c.secret, 'base64url'))
      .update(`${c.id}.${step}`)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    return `JWR2.${c.id}.${step}.${mac}`;
  }

  return {
    ...x,
    x,
    guardInZone,
    guardAt,
    sosRaw,
    sos,
    lockdownRaw,
    lockdown,
    endLockdownRaw,
    entryRaw,
    verifyRaw,
    passWithCode,
    residentQr,
  };
}
