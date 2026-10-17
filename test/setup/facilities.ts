import type { Response } from 'supertest';
import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import { RolesService } from '../../src/core/access/roles.service';
import { newId } from '../../src/core/common/uuid';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import type { Permission } from '../../src/core/access/permissions';
import { day } from './compound-clock';
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

// The compound's calendar (test/setup/compound-clock.ts).
export { at, day, ZONE } from './compound-clock';

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

  /** Runs one sweep now, or at `now`. */
  function sweep(name: string, now: Date = new Date()) {
    return h.moduleRef.get(SweepRunner).run(name, now);
  }

  /**
   * A booking written straight into the table, for a time the API would
   * refuse (one whose start has passed): its id.
   */
  async function rawBooking(
    c: Compound,
    input: {
      facilityId: string;
      unitId: string;
      bookedById: string;
      startsAt: Date;
      minutes?: number;
      status?: 'pending' | 'confirmed';
      createdAt?: Date;
    },
  ): Promise<string> {
    const id = newId();
    await inTx(c, (tx) =>
      tx.booking.create({
        data: {
          id,
          tenantId: c.tenantId,
          facilityId: input.facilityId,
          unitId: input.unitId,
          bookedById: input.bookedById,
          startsAt: input.startsAt,
          endsAt: new Date(
            input.startsAt.getTime() + (input.minutes ?? 60) * 60_000,
          ),
          guests: 0,
          partySize: 1,
          peak: false,
          status: input.status ?? 'confirmed',
          ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        },
      }),
    );
    return id;
  }

  /** A club plan of the compound, as the manager: its id. */
  async function plan(
    c: Compound,
    manager: Who,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await http('post', '/staff/club-plans', manager.token, {
      nameEn: 'Monthly',
      nameAr: 'شهري',
      durationKind: 'monthly',
      price: '500',
      ...over,
    }).expect(201);
    return (res.body as { id: string }).id;
  }

  /** The unit's people a membership may cover, as the accountant sees them. */
  async function people(c: Compound, as: Who, unitId: string) {
    const res = await http(
      'get',
      `/staff/club/units/${unitId}/people`,
      as.token,
    ).expect(200);
    return (
      res.body as {
        data: {
          kind: 'occupancy' | 'member';
          id: string;
          fullName: string | null;
          isMinor: boolean;
        }[];
      }
    ).data;
  }

  /** A membership of the unit covering everyone in it now: its id. */
  async function membership(
    c: Compound,
    as: Who,
    unitId: string,
  ): Promise<string> {
    const everyone = (await people(c, as, unitId)).map((p) =>
      p.kind === 'occupancy' ? { occupancyId: p.id } : { memberId: p.id },
    );
    const res = await http('post', '/staff/club-memberships', as.token, {
      unitId,
      people: everyone,
    }).expect(201);
    return (res.body as { id: string }).id;
  }

  let receipts = 0;
  /** `POST /staff/club-memberships/:id/payments`: the response. */
  function pay(
    as: Who,
    membershipId: string,
    planId: string,
    over: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    return http(
      'post',
      `/staff/club-memberships/${membershipId}/payments`,
      as.token,
      {
        planId,
        amount: '500',
        receiptNumber: `R-${Date.now()}-${receipts++}`,
        paidOn: day(0),
        ...over,
      },
      headers,
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
    sweep,
    rawBooking,
    plan,
    people,
    membership,
    pay,
  };
}

export type FacilitiesSetUp = Awaited<
  ReturnType<ReturnType<typeof facilitiesHelpers>['setUp']>
>;
