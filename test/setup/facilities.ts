import { RolesService } from '../../src/core/access/roles.service';
import type { Permission } from '../../src/core/access/permissions';
import type { Compound } from './community';
import { engagementHelpers, type Who } from './engagement';
import { gateHelpers } from './gate';
import type { HttpHarness } from './http-app';

export type { Who } from './engagement';

/** Every day of the week, 06:00 to 22:00. */
export const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 360,
  endMinute: 1320,
}));

/**
 * Helpers for the facilities suites (ADR 0044): a compound with two homes
 * and their owners, the manager, staff who handle bookings, an accountant,
 * and the residents' and the staff's calls over HTTP.
 */
export function facilitiesHelpers(h: HttpHarness) {
  const e = engagementHelpers(h);
  const { x, who, http, unit, owner, tenant, landlord, family, inTx } = e;

  /**
   * A staff account holding exactly `permissions` (by default the
   * handler's). No default staff role works bookings, so one of the
   * compound's staff roles is given them, as a manager would in the roles
   * screen: a role per set.
   */
  async function staff(
    c: Compound,
    permissions: Permission[] = ['bookings.handle'],
  ): Promise<Who> {
    const set = [...permissions].sort().join(',');
    const key =
      set === 'bookings.handle'
        ? 'maintenance_supervisor'
        : permissions.length
          ? 'technician'
          : 'guard';
    await x.asManager(c, async () => {
      const role = await x.prisma.tenant.role.findUniqueOrThrow({
        where: { tenantId_key: { tenantId: c.tenantId, key } },
      });
      await h.moduleRef
        .get(RolesService)
        .replacePermissions(role.id, permissions);
    });
    return who(c, (await gateHelpers(h).guard(c, key)).id, 'staff');
  }

  /** An account of the compound's accountant role, as created. */
  async function accountant(c: Compound): Promise<Who> {
    return who(c, (await gateHelpers(h).guard(c, 'accountant')).id, 'staff');
  }

  /**
   * A compound, its manager, a handler, and two homes in building A, each
   * with its owner living there (its primary).
   */
  async function setUp() {
    const c = await x.compound('Facilities Court');
    const homeA = await unit(c, 'A');
    const homeB = await unit(c, 'A');
    return {
      c,
      homeA,
      homeB,
      manager: await who(c, c.managerId, 'manager'),
      handler: await staff(c),
      alice: await owner(c, homeA.id),
      bob: await owner(c, homeB.id),
    };
  }

  /**
   * `POST /staff/facilities` as the manager, then its hours (every day,
   * 06:00–22:00, unless `hours` says otherwise): the facility's id. A
   * bookable court by default: one-hour slots, one booking each.
   */
  async function facility(
    c: Compound,
    manager: Who,
    over: Record<string, unknown> = {},
    hours: object[] = ALL_WEEK,
  ): Promise<string> {
    const created = await http('post', '/staff/facilities', manager.token, {
      mode: 'bookable',
      nameEn: 'Court',
      nameAr: 'ملعب',
      slotMinutes: 60,
      capacity: 1,
      ...over,
    }).expect(201);
    const id = (created.body as { id: string }).id;
    await http('put', `/staff/facilities/${id}/hours`, manager.token, {
      windows: hours,
    }).expect(200);
    return id;
  }

  return {
    ...e,
    x,
    who,
    http,
    unit,
    owner,
    tenant,
    landlord,
    family,
    inTx,
    staff,
    accountant,
    setUp,
    facility,
  };
}

export type FacilitiesSetUp = Awaited<
  ReturnType<ReturnType<typeof facilitiesHelpers>['setUp']>
>;
