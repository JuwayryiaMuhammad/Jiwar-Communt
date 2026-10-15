import type { Compound } from './community';
import { gateHelpers } from './gate';
import type { HttpHarness } from './http-app';
import { vehicleHelpers, type Who } from './vehicles';

export type { Who } from './vehicles';

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

  return { ...v, v, g, setUp, guardOnDuty, places };
}
