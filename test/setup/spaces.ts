import { newId } from '../../src/core/common/uuid';
import type { Compound } from './community';
import { at, day, facilitiesHelpers, type Who } from './facilities';
import { fileHelpers } from './files';
import { uniqueSuffix } from './fixtures';
import type { HttpHarness } from './http-app';

export { at, day, ZONE } from './facilities';
export type { Who } from './facilities';

/** A use request as the API returns it (ADR 0084). */
export interface SpaceUseBody {
  id: string;
  commonAreaId: string;
  areaCode: string;
  unitId: string;
  unitCode: string;
  startsAt: string;
  endsAt: string;
  purpose: string | null;
  guests: number;
  status: string;
  reasonCode: string | null;
  mine?: boolean;
}

/**
 * Helpers for the spaces suites (ADR 0084), over the facilities' own: a
 * compound with two homes on floor 3 of building A (each with its owner
 * living there), the manager, a bookings handler; common areas, files and
 * calls over HTTP.
 */
export function spacesHelpers(h: HttpHarness) {
  const f = facilitiesHelpers(h);
  const files = fileHelpers(h);
  const { http, inTx } = f;

  async function setUp(name = 'Spaces Court') {
    const c = await f.x.compound(name);
    const homeA = await f.unit(c, 'A');
    const homeB = await f.unit(c, 'A');
    await inTx(c, (tx) =>
      tx.unit.updateMany({
        where: { id: { in: [homeA.id, homeB.id] } },
        data: { floor: 3 },
      }),
    );
    const buildingId = (
      await inTx(c, (tx) =>
        tx.unit.findUniqueOrThrow({ where: { id: homeA.id } }),
      )
    ).buildingId!;
    return {
      c,
      homeA,
      homeB,
      buildingId,
      manager: await f.who(c, c.managerId, 'manager'),
      handler: await f.staff(c),
      alice: await f.owner(c, homeA.id),
      bob: await f.owner(c, homeB.id),
    };
  }

  /** A common area of the compound (an area; or the facility's), its id. */
  async function area(
    c: Compound,
    o: { facilityId?: string; open?: boolean; manager?: Who } = {},
  ): Promise<string> {
    const id = newId();
    await inTx(c, (tx) =>
      tx.commonArea.create({
        data: {
          id,
          tenantId: c.tenantId,
          kind: o.facilityId ? 'facility' : 'area',
          code: `SP-${uniqueSuffix()}`,
          nameAr: 'حديقة',
          nameEn: 'Garden',
          facilityId: o.facilityId ?? null,
        },
      }),
    );
    if (o.open !== false && o.manager)
      await http('put', `/staff/space-use-areas/${id}`, o.manager.token).expect(
        204,
      );
    return id;
  }

  /** `POST /units/:unitId/space-uses`: the response. */
  function askRaw(
    as: Who,
    unitId: string,
    commonAreaId: string,
    startsAt: Date,
    hours = 2,
    over: Record<string, unknown> = {},
  ) {
    return http('post', `/units/${unitId}/space-uses`, as.token, {
      commonAreaId,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + hours * 3_600_000).toISOString(),
      purpose: 'A birthday for the children',
      guests: 10,
      ...over,
    });
  }

  async function ask(
    as: Who,
    unitId: string,
    commonAreaId: string,
    startsAt: Date,
    hours = 2,
  ): Promise<SpaceUseBody> {
    const res = await askRaw(as, unitId, commonAreaId, startsAt, hours);
    if (res.status !== 201)
      throw new Error(
        `asking refused: ${res.status} ${JSON.stringify(res.body)}`,
      );
    return res.body as SpaceUseBody;
  }

  /** A staff decision: approve, refuse or cancel. */
  function decide(
    as: Who,
    id: string,
    action: 'approve' | 'refuse' | 'cancel',
    reasonCode?: string,
  ) {
    return http(
      'post',
      `/staff/space-uses/${id}/${action}`,
      as.token,
      reasonCode ? { reasonCode } : {},
    );
  }

  /** A finalized image of the caller's for a purpose: its id. */
  const image = (as: Who, purpose: 'site_map' | 'floor_plan') =>
    files.ready(as.token, purpose);

  /** `GET …/closure-preview`: its body. */
  async function preview(
    as: Who,
    facilityId: string,
    startsAt: Date,
    endsAt: Date,
  ) {
    const q = new URLSearchParams({
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    });
    return (
      await http(
        'get',
        `/staff/facilities/${facilityId}/closure-preview?${q.toString()}`,
        as.token,
      ).expect(200)
    ).body as {
      bookings: {
        id: string;
        unitCode: string;
        charge: { amount: string; status: string; outcome: string } | null;
      }[];
      invoicesCredited: string;
      unitCredit: string;
      previewToken: string;
    };
  }

  /** `POST …/closures`: the response. */
  function close(
    as: Who,
    facilityId: string,
    startsAt: Date,
    endsAt: Date,
    previewToken?: string,
  ) {
    return http('post', `/staff/facilities/${facilityId}/closures`, as.token, {
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      reasonCode: 'maintenance',
      ...(previewToken ? { previewToken } : {}),
    });
  }

  return {
    ...f,
    f,
    files,
    setUp,
    area,
    askRaw,
    ask,
    decide,
    image,
    preview,
    close,
    at,
    day,
  };
}

export type SpacesSetUp = Awaited<
  ReturnType<ReturnType<typeof spacesHelpers>['setUp']>
>;
