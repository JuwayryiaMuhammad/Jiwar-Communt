import { createHash } from 'node:crypto';
import type { Response } from 'supertest';
import { RolesService } from '../../src/core/access/roles.service';
import type { Permission } from '../../src/core/access/permissions';
import { newId } from '../../src/core/common/uuid';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import type { Compound } from './community';
import { engagementHelpers, type Who } from './engagement';
import { day } from './facilities';
import { fileHelpers } from './files';
import { uniqueSuffix } from './fixtures';
import { gateHelpers } from './gate';
import type { HttpHarness } from './http-app';

export type { Who } from './engagement';
export { at, day, ZONE } from './facilities';

export interface VehicleBody {
  id: string;
  reference: string;
  plate: string;
  makeAndModel: string;
  color: string;
  type: string;
  permitStatus: string;
  permitValidUntil: string | null;
  stickerNumber: string | null;
  rejectionReason: string | null;
  licencePhotoUrl: string | null;
  canManage: boolean;
  createdAt: string;
}

export interface StaffVehicleBody extends Omit<
  VehicleBody,
  'canManage' | 'licencePhotoUrl' | 'rejectionReason'
> {
  unitId: string;
  unitCode: string;
  status: string;
  version: number;
  registeredBy: { id: string; fullName?: string | null; erased?: true };
}

/** A plate nobody else in the test run has: four letters or digits, then four digits. */
export function plate(): string {
  const n = String(Math.floor(Math.random() * 1e4)).padStart(4, '0');
  return `${uniqueSuffix().slice(-4).toUpperCase()} ${n}`;
}

/** A sticker number nobody else in the test run has. */
export const sticker = () =>
  `S-${uniqueSuffix()
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-12)}`.toUpperCase();

/**
 * Helpers for the vehicles and parking suites (ADR 0045): a compound with
 * homes and their people, the manager, staff holding exactly the
 * permissions a test names, and calls over HTTP.
 */
export function vehicleHelpers(h: HttpHarness) {
  const e = engagementHelpers(h);
  const { x, who, http, unit, owner, tenant, landlord, family, inTx } = e;
  const files = fileHelpers(h);

  /**
   * A staff account holding exactly `permissions`. No default staff role
   * holds a vehicles permission but the accountant's fines.billing, so each
   * set gets a role of its own, as a manager would make in the roles
   * screen: two accounts of a suite share a role only when they share the
   * set, and a test never changes another's.
   */
  async function staff(c: Compound, permissions: Permission[]): Promise<Who> {
    const set = [...permissions].sort().join(',');
    const key =
      set === 'fines.billing'
        ? 'accountant'
        : `staff-${createHash('sha1').update(set).digest('hex').slice(0, 12)}`;
    if (key !== 'accountant')
      await x.asManager(c, async () => {
        const known = await x.prisma.tenant.role.findUnique({
          where: { tenantId_key: { tenantId: c.tenantId, key } },
        });
        if (known) return;
        const role = await x.prisma.tenant.role.create({
          data: { id: newId(), tenantId: c.tenantId, key, kind: 'staff' },
        });
        await h.moduleRef
          .get(RolesService)
          .replacePermissions(role.id, permissions);
      });
    return who(c, (await gateHelpers(h).guard(c, key)).id, 'staff');
  }

  /** A compound, its manager, and a home where `alice` lives (its primary). */
  async function setUp() {
    const c = await x.compound('Vehicles Court');
    const home = await unit(c, 'A');
    return {
      c,
      home,
      manager: await who(c, c.managerId, 'manager'),
      alice: await owner(c, home.id),
    };
  }

  /** `POST /units/:unitId/vehicles`: the response. */
  function registerRaw(
    as: Who,
    unitId: string,
    over: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return (async () =>
      await http(
        'post',
        `/units/${unitId}/vehicles`,
        as.token,
        {
          plate: plate(),
          makeAndModel: 'Hyundai Elantra',
          color: 'Silver',
          type: 'car',
          ...over,
        },
        headers,
      ))();
  }

  /** A registration that must succeed: its body. */
  async function register(
    as: Who,
    unitId: string,
    over: Record<string, unknown> = {},
  ): Promise<VehicleBody> {
    const res = await registerRaw(as, unitId, over);
    if (res.status !== 201)
      throw new Error(`register: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as VehicleBody;
  }

  /** `GET /staff/vehicles/:id` as `staffer`. */
  async function staffView(
    staffer: Who,
    id: string,
  ): Promise<StaffVehicleBody> {
    return (
      await http('get', `/staff/vehicles/${id}`, staffer.token).expect(200)
    ).body as StaffVehicleBody;
  }

  /** `POST /staff/vehicles/:id/approve` as read now: the response. */
  async function approveRaw(
    staffer: Who,
    id: string,
    over: {
      stickerNumber?: string;
      permitValidUntil?: string;
      version?: number;
    } = {},
  ): Promise<Response> {
    const version = over.version ?? (await staffView(staffer, id)).version;
    return http('post', `/staff/vehicles/${id}/approve`, staffer.token, {
      version,
      stickerNumber: over.stickerNumber ?? sticker(),
      permitValidUntil: over.permitValidUntil ?? day(365),
    });
  }

  /** A minute-aligned instant `minutes` from now. */
  const inMinutes = (minutes: number) =>
    new Date(Math.ceil(Date.now() / 60_000) * 60_000 + minutes * 60_000);

  /** A visitor area of the compound, as the manager: its id. */
  async function area(c: Compound, manager: Who, capacity = 1) {
    const res = await http(
      'post',
      '/staff/visitor-parking-areas',
      manager.token,
      {
        name: `Area ${uniqueSuffix()}`,
        capacity,
      },
    ).expect(201);
    return (res.body as { id: string }).id;
  }

  /** `POST /units/:unitId/visitor-parking-bookings`: the response. */
  function parkRaw(
    as: Who,
    unitId: string,
    body: {
      areaId: string;
      startsAt: Date;
      endsAt: Date;
      visitorPassId?: string | null;
      visitorName?: string;
    },
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const { startsAt, endsAt, ...rest } = body;
    return (async () =>
      await http(
        'post',
        `/units/${unitId}/visitor-parking-bookings`,
        as.token,
        {
          ...(rest.visitorPassId ? {} : { visitorName: 'Guest' }),
          ...rest,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        },
        headers,
      ))();
  }

  /** A visitor pass of the unit (one-time, for the next hours): its id. */
  async function pass(
    as: Who,
    unitId: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await http(
      'post',
      `/units/${unitId}/visitor-passes`,
      as.token,
      {
        kind: 'one_time',
        partySize: 1,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 6 * 3_600_000).toISOString(),
        ...over,
      },
    );
    if (res.status !== 201)
      throw new Error(`pass: ${res.status} ${JSON.stringify(res.body)}`);
    return (res.body as { id: string }).id;
  }

  /** A finalized licence photo of `as`. */
  const licence = (as: Who) => files.ready(as.token, 'vehicle_licence');

  /** The vehicle's row. */
  function row(c: Compound, id: string) {
    return inTx(c, (tx) => tx.vehicle.findUniqueOrThrow({ where: { id } }));
  }

  /** Runs one sweep now, or at `now`. */
  function sweep(name: string, now: Date = new Date()) {
    return h.moduleRef.get(SweepRunner).run(name, now);
  }

  return {
    x,
    e,
    who,
    http,
    files,
    unit,
    owner,
    tenant,
    landlord,
    family,
    inTx,
    staff,
    setUp,
    registerRaw,
    register,
    staffView,
    approveRaw,
    licence,
    row,
    sweep,
    notifications: e.notifications,
    inMinutes,
    area,
    parkRaw,
    pass,
  };
}
