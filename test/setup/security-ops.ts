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

  return { ...x, x, guardInZone, guardAt, sosRaw, sos };
}
