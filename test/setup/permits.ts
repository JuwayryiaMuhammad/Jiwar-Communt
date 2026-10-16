import type { Response } from 'supertest';
import type { Compound } from './community';
import { day } from './facilities';
import type { HttpHarness } from './http-app';
import { safetyHelpers, type Who } from './safety';

export type { Who } from './safety';
export { at, day, ZONE } from './facilities';

/** The compound's permit rules as the API returns them (ADR 0049). */
export interface PermitSettingsBody {
  workDays: number[];
  workHours: { from: string; to: string };
  daysOff: string[];
}

export interface PermitWorkerBody {
  id: string;
  fullName: string | null;
  idType: string;
  photo: { url: string; expiresAt: string } | null;
  addedAt: string;
  removedAt: string | null;
  removedBy: string | null;
}

export interface PermitGuestBody {
  id: string;
  fullName: string | null;
  vehiclePlate: string | null;
  removedAt: string | null;
}

/** A permit as the household's view returns it. */
export interface PermitBody {
  id: string;
  reference: string;
  kind: 'works' | 'move' | 'material_exit' | 'event';
  status: string;
  unitId: string;
  unitCode: string;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  decisionSource: string | null;
  decidedAt: string | null;
  rejectReason: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  mine?: boolean;
  requestedBy: { id: string; firstName?: string | null; fullName?: string };
  staffNote?: string | null;
  revokeNote?: string | null;
  works: {
    workType: string;
    startsOn: string;
    endsOn: string;
    dailyHours: { from: string; to: string };
    contractorCompany: string | null;
    description: string | null;
    workerCount: number;
    workers: PermitWorkerBody[];
  } | null;
  move: {
    date: string;
    window: { from: string; to: string };
    truckPlate: string | null;
    itemsDescription: string | null;
  } | null;
  materialExit: {
    validFrom: string;
    validUntil: string;
    items: { name: string; quantity: number }[] | null;
    photo: { url: string } | null;
    usedAt: string | null;
  } | null;
  event: {
    title: string | null;
    guestLimit: number;
    guestCount: number;
    guests: PermitGuestBody[];
  } | null;
}

let worker = 0;

/**
 * Helpers for the permits suites (ADR 0049): a compound with a home and its
 * primary, the manager, guards on duty, staff holding exactly the
 * permissions a test names, and calls over HTTP.
 */
export function permitHelpers(h: HttpHarness) {
  const s = safetyHelpers(h);
  const { v, who, http } = s;

  /** A compound, its manager, and a home where `alice` lives (its primary). */
  async function setUp(name = 'Permits Court') {
    const c = await v.x.compound(name);
    const home = await v.unit(c, 'P1');
    return {
      c,
      home,
      manager: await who(c, c.managerId, 'manager'),
      alice: await v.owner(c, home.id),
    };
  }

  /** `PATCH /staff/permit-settings` as `as`: the new rules. */
  async function setRules(
    as: Who,
    body: Partial<PermitSettingsBody>,
  ): Promise<PermitSettingsBody> {
    return (
      await http('patch', '/staff/permit-settings', as.token, body).expect(200)
    ).body as PermitSettingsBody;
  }

  /** Every day, all day long: no rule refuses anything (a test's own). */
  const anyTime = (as: Who) =>
    setRules(as, {
      workDays: [0, 1, 2, 3, 4, 5, 6],
      workHours: { from: '00:00', to: '23:59' },
      daysOff: [],
    });

  /** A works permit's body: tomorrow to a week on, 09:00–17:00. */
  const worksBody = (over: Record<string, unknown> = {}) => ({
    workType: 'renovation',
    startsOn: day(1),
    endsOn: day(7),
    dailyHours: { from: '09:00', to: '17:00' },
    contractorCompany: 'Nile Builders',
    description: 'New kitchen tiles',
    ...over,
  });

  function worksRaw(
    as: Who,
    unitId: string,
    over: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    return http(
      'post',
      `/units/${unitId}/permits/works`,
      as.token,
      worksBody(over),
      headers,
    );
  }

  /** A works permit that must be made: its body. */
  async function works(
    as: Who,
    unitId: string,
    over: Record<string, unknown> = {},
  ): Promise<PermitBody> {
    const res = await worksRaw(as, unitId, over);
    if (res.status !== 201)
      throw new Error(`works: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as PermitBody;
  }

  /** A worker's body, with a fresh face of `as`'s. */
  async function workerBody(as: Who, over: Record<string, unknown> = {}) {
    worker += 1;
    return {
      fullName: `Contractor Worker ${worker}`,
      photoFileId: await s.files.ready(as.token, 'contractor_photo'),
      idType: 'national_id',
      idLast4: '4821',
      ...over,
    };
  }

  /** `POST /permits/:id/workers` with a fresh face: the response. */
  async function addWorkerRaw(
    as: Who,
    permitId: string,
    over: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const body = await workerBody(as, over);
    return await http(
      'post',
      `/permits/${permitId}/workers`,
      as.token,
      body,
      headers,
    );
  }

  /** The response when it has `code`; else a failure that shows its body. */
  function status(res: Response, code: number): Response {
    if (res.status !== code)
      throw new Error(
        `expected ${code}, got ${res.status} ${JSON.stringify(res.body)}`,
      );
    return res;
  }

  /** Adds a worker that must be added: the permit, and the new worker. */
  async function addWorker(
    as: Who,
    permitId: string,
    over: Record<string, unknown> = {},
  ): Promise<{ permit: PermitBody; worker: PermitWorkerBody }> {
    const res = await addWorkerRaw(as, permitId, over);
    if (res.status !== 201)
      throw new Error(`addWorker: ${res.status} ${JSON.stringify(res.body)}`);
    const permit = res.body as PermitBody;
    return { permit, worker: permit.works!.workers.at(-1)! };
  }

  /** `GET /permits/:id` as `as`. */
  async function get(as: Who, id: string): Promise<PermitBody> {
    return (await http('get', `/permits/${id}`, as.token).expect(200))
      .body as PermitBody;
  }

  /** The permit's row. */
  function row(c: Compound, id: string) {
    return v.inTx(c, (tx) =>
      tx.unitPermit.findUniqueOrThrow({ where: { id } }),
    );
  }

  /** The kinds and params of an account's notifications about `targetId`. */
  async function told(c: Compound, accountId: string, targetId: string) {
    return (await v.notifications(c, accountId))
      .filter((n) => n.targetId === targetId)
      .map((n) => ({ kind: n.kind, params: n.params }));
  }

  return {
    ...s,
    s,
    setUp,
    setRules,
    anyTime,
    worksBody,
    worksRaw,
    works,
    workerBody,
    addWorkerRaw,
    status,
    addWorker,
    get,
    row,
    told,
  };
}

export type PermitSetUp = Awaited<
  ReturnType<ReturnType<typeof permitHelpers>['setUp']>
>;
export type { Compound };
