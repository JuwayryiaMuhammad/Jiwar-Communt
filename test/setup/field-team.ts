import { newId } from '../../src/core/common/uuid';
import type { Compound } from './community';
import type { HttpHarness } from './http-app';
import type { Who } from './safety';
import { securityHelpers } from './security';

const MINUTE = 60_000;

/**
 * Helpers for the field team suites (ADR 0078), on top of the guards'
 * ones: technicians, the maintenance supervisor who runs the field team,
 * going on and off duty over HTTP, and a technician's slot written
 * straight into the roster.
 */
export function fieldTeamHelpers(h: HttpHarness) {
  const s = securityHelpers(h);
  const { v, g } = s;

  /** A compound, its manager, the field team's supervisor and a home. */
  async function setUp(name = 'Field Team Court') {
    const base = await s.setUp(name);
    return {
      ...base,
      boss: await v.who(
        base.c,
        (await g.guard(base.c, 'maintenance_supervisor')).id,
        'staff',
      ),
    };
  }

  /** A technician, off duty. */
  async function technician(c: Compound): Promise<Who> {
    return v.who(c, (await g.guard(c, 'technician')).id, 'staff');
  }

  /** `POST /technician/availability` as the technician. */
  function dutyRaw(as: Who, onDuty: boolean) {
    return v.http('post', '/technician/availability', as.token, {
      state: onDuty ? 'available' : 'unavailable',
    });
  }

  const onDuty = (as: Who) => dutyRaw(as, true).expect(200);
  const offDuty = (as: Who) => dutyRaw(as, false).expect(200);

  /**
   * A technician's slot that started `startsAgo` minutes ago (or starts
   * that far ahead when negative), made a day before it: setup, not a test.
   */
  function dutySlot(
    c: Compound,
    technicianId: string,
    startsAgo: number,
    lasts = 480,
    placeId: string | null = null,
  ) {
    const startsAt = new Date(Date.now() - startsAgo * MINUTE);
    return v.inTx(c, (tx) =>
      tx.guardRosterSlot.create({
        data: {
          id: newId(),
          tenantId: c.tenantId,
          crew: 'maintenance',
          guardAccountId: technicianId,
          gateId: null,
          placeId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + lasts * MINUTE),
          createdById: c.managerId,
          // eslint-disable-next-line no-restricted-syntax -- any instant before the start: only its order with the start counts
          createdAt: new Date(startsAt.getTime() - 24 * 60 * MINUTE),
        },
      }),
    );
  }

  /** `POST /staff/field-team/roster/templates` as `as`. */
  function templateRaw(as: Who, body: object) {
    return v.http('post', '/staff/field-team/roster/templates', as.token, body);
  }

  /** `POST /staff/field-team/roster/slots` as `as`. */
  function slotRaw(as: Who, body: object) {
    return v.http('post', '/staff/field-team/roster/slots', as.token, body);
  }

  return {
    ...s,
    s,
    setUp,
    technician,
    dutyRaw,
    onDuty,
    offDuty,
    dutySlot,
    templateRaw,
    slotRaw,
  };
}
