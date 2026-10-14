import type { Response } from 'supertest';
import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import { RolesService } from '../../src/core/access/roles.service';
import type { Permission } from '../../src/core/access/permissions';
import { localDate, zonedInstant } from '../../src/core/common/slots/day-slots';
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

/** Every compound's time zone unless it says otherwise. */
export const ZONE = 'Africa/Cairo';
const DAY = 86_400_000;

/** The compound's local day `n` days from today, `YYYY-MM-DD`. */
export const day = (n: number) =>
  localDate(new Date(Date.now() + n * DAY), ZONE);

/** The instant a local day reads `hour:minute` in the compound. */
export const at = (date: string, hour: number, minute = 0) =>
  zonedInstant(date, hour * 60 + minute, ZONE)!;

export interface BookingBody {
  id: string;
  facilityId: string;
  unitId: string;
  startsAt: string;
  endsAt: string;
  guests: number;
  peak: boolean;
  status: string;
  mine: boolean;
  rejectReason: string | null;
  cancelledSide: string | null;
  cancelReason: string | null;
}

export interface SlotBody {
  startsAt: string;
  endsAt: string;
  peak: boolean;
  state: 'free' | 'full';
  mine: boolean;
}

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

  /** `POST /units/:unitId/bookings`: the response. */
  function bookRaw(
    as: Who,
    unitId: string,
    facilityId: string,
    startsAt: Date,
    over: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return (async () =>
      await http(
        'post',
        `/units/${unitId}/bookings`,
        as.token,
        { facilityId, startsAt: startsAt.toISOString(), ...over },
        headers,
      ))();
  }

  /** A booking that must succeed: its body. */
  async function book(
    as: Who,
    unitId: string,
    facilityId: string,
    startsAt: Date,
    over: Record<string, unknown> = {},
  ): Promise<BookingBody> {
    const res = await bookRaw(as, unitId, facilityId, startsAt, over);
    if (res.status !== 201)
      throw new Error(
        `booking refused: ${res.status} ${JSON.stringify(res.body)}`,
      );
    return res.body as BookingBody;
  }

  /** `POST /bookings/:id/cancel`. */
  function cancel(as: Who, id: string, reasonCode = 'no_longer_needed') {
    return http('post', `/bookings/${id}/cancel`, as.token, { reasonCode });
  }

  /** `GET /facilities/:id/slots`: the day's slots. */
  async function slots(
    as: Who,
    facilityId: string,
    date: string,
    unitId?: string,
  ): Promise<SlotBody[]> {
    const q = new URLSearchParams({ date, ...(unitId ? { unitId } : {}) });
    const res = await http(
      'get',
      `/facilities/${facilityId}/slots?${q.toString()}`,
      as.token,
    ).expect(200);
    return (res.body as { slots: SlotBody[] }).slots;
  }

  /** The booking's row. */
  function row(c: Compound, id: string) {
    return inTx(c, (tx) => tx.booking.findUniqueOrThrow({ where: { id } }));
  }

  /** How many bookings hold the facility (pending or confirmed). */
  function holding(c: Compound, facilityId: string) {
    return inTx(c, (tx) =>
      tx.booking.count({
        where: { facilityId, status: { in: ['pending', 'confirmed'] } },
      }),
    );
  }

  /** The primary takes `bookings` from a member. */
  function revokeBookings(c: Compound, primary: Who, memberId: string) {
    return x.as(c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef.get(MemberPermissionsService).revoke(memberId, 'bookings', {
        code: 'no_longer_needed',
        text: 'Test',
      }),
    );
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
    bookRaw,
    book,
    cancel,
    slots,
    row,
    holding,
    revokeBookings,
  };
}

export type FacilitiesSetUp = Awaited<
  ReturnType<ReturnType<typeof facilitiesHelpers>['setUp']>
>;
