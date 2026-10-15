import type { Compound } from './community';
import { gateHelpers } from './gate';
import type { HttpHarness } from './http-app';
import { vehicleHelpers, type Who } from './vehicles';

export type { Who } from './vehicles';

export interface EmergencyBody {
  id: string;
  reference: string;
  type: string;
  status: string;
  reportedAt: string;
  location: { unitId: string; unitCode: string; building: string | null };
  reportedBy: { id: string; firstName?: string | null; erased?: true };
  responder: { firstName: string | null; phone: string | null } | null;
  minutesAway: number | null;
  familyNotified: number;
  familyOnTheWay: number;
  timeline: { step: string; at: string; firstName?: string | null }[];
  closeReason: string | null;
  onMyWay: boolean | null;
  canCancel: boolean;
}

export interface PlaceBody {
  id: string;
  key: string | null;
  nameEn: string;
  nameAr: string;
}

/**
 * Helpers for the emergencies and gate services suites (ADR 0047): a
 * compound with homes and their people, the manager, guards on duty,
 * staff holding exactly the permissions a test names, and calls over HTTP.
 */
export function safetyHelpers(h: HttpHarness) {
  const v = vehicleHelpers(h);
  const g = gateHelpers(h);

  /** A compound, its manager, and a home where `alice` lives (its primary). */
  async function setUp(name = 'Safety Court') {
    const c = await v.x.compound(name);
    const home = await v.unit(c, 'B7');
    return {
      c,
      home,
      manager: await v.who(c, c.managerId, 'manager'),
      alice: await v.owner(c, home.id),
    };
  }

  /** A guard on an open shift: who, their gate and its shift. */
  async function guardOnDuty(
    c: Compound,
  ): Promise<Who & { gateId: string; shiftId: string }> {
    const duty = await g.onDuty(c);
    return {
      ...(await v.who(c, duty.guardId, 'staff')),
      gateId: duty.gateId,
      shiftId: duty.shiftId,
    };
  }

  /** The compound's places in service, keyed. */
  async function places(as: Who): Promise<Record<string, PlaceBody>> {
    const res = await v.http('get', '/community/places', as.token).expect(200);
    return Object.fromEntries(
      (res.body as { data: PlaceBody[] }).data.map((p) => [
        p.key ?? p.nameEn,
        p,
      ]),
    );
  }

  /** `POST /emergencies` as `as`: the response. */
  function reportRaw(
    as: Who,
    unitId: string,
    type = 'medical',
    headers: Record<string, string> = {},
  ) {
    return v.http('post', '/emergencies', as.token, { type, unitId }, headers);
  }

  /** A report that must make a new emergency: its body. */
  async function report(
    as: Who,
    unitId: string,
    type = 'medical',
  ): Promise<EmergencyBody> {
    const res = await reportRaw(as, unitId, type);
    if (res.status !== 201)
      throw new Error(`report: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as EmergencyBody;
  }

  /** `GET /emergencies/:id` as `as`. */
  async function follow(as: Who, id: string): Promise<EmergencyBody> {
    return (await v.http('get', `/emergencies/${id}`, as.token).expect(200))
      .body as EmergencyBody;
  }

  /** The kinds of the account's notifications about `targetId`, in order. */
  async function told(c: Compound, accountId: string, targetId: string) {
    return (await v.notifications(c, accountId))
      .filter((n) => n.targetId === targetId)
      .map((n) => ({ kind: n.kind, params: n.params }));
  }

  return {
    ...v,
    v,
    g,
    setUp,
    guardOnDuty,
    places,
    reportRaw,
    report,
    follow,
    told,
  };
}
