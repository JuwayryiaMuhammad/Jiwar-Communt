import type { Response } from 'supertest';
import { TenantSettingsService } from '../../src/core/tenant-settings/tenant-settings.service';
import type { Compound } from './community';
import { addDays } from '../../src/core/common/slots/day-slots';
import { clock, type Clock, type LocalDate } from './compound-clock';
import { at, day } from './facilities';
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

/** The rules as the residents read them: with the zone they are read in. */
export interface PermitRulesBody extends PermitSettingsBody {
  timeZone: string;
}

/**
 * A new compound's rules (permit_settings' defaults): for a caller the API
 * refuses before it reads the body, who may not read the rules either.
 */
const PROVISIONED: PermitRulesBody = {
  workDays: [0, 1, 2, 3, 4, 6],
  workHours: { from: '09:00', to: '17:00' },
  daysOff: [],
  timeZone: 'Africa/Cairo',
};

/** How far ahead a permit's day may be (PERMIT_LIMITS.maxDaysAhead). */
const MAX_DAYS_AHEAD = 90;

/**
 * The first `count` work days of the compound under `rules` (a week day it
 * works, not a day off) on or after `from` days from today, by its clock.
 * Never a fixed offset: that is a day off on some week days.
 */
export function workDaysOf(
  rules: PermitRulesBody,
  count = 1,
  from = 1,
  c: Clock = clock(rules.timeZone),
): LocalDate[] {
  const out: LocalDate[] = [];
  for (let n = from; out.length < count && n <= MAX_DAYS_AHEAD; n += 1) {
    const date = c.day(n);
    if (
      rules.workDays.includes(c.weekday(date)) &&
      !rules.daysOff.includes(date)
    )
      out.push(date);
  }
  if (out.length < count)
    throw new Error(`No ${count} work days within ${MAX_DAYS_AHEAD} days`);
  return out;
}

/** `wanted` when the compound's hours hold it; else its first two hours. */
export function withinHours(
  rules: PermitSettingsBody,
  wanted: { from: string; to: string },
): { from: string; to: string } {
  const { from, to } = rules.workHours;
  if (wanted.from >= from && wanted.to <= to) return wanted;
  const [h, m] = from.split(':').map(Number);
  const twoHours = `${String(Math.min(h + 2, 23)).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return { from, to: twoHours < to ? twoHours : to };
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
    direction: string | null;
    moveId: string | null;
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

  /**
   * A compound, its manager, and a home where `alice` lives (its primary);
   * in `zone` when given (middayZone(): "in a few hours" stays today).
   */
  async function setUp(name = 'Permits Court', zone?: string) {
    const c = await v.x.compound(name);
    if (zone)
      await v.x.asManager(c, () =>
        h.moduleRef.get(TenantSettingsService).update({ timezone: zone }),
      );
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

  /** The compound's rules as `as` reads them (`GET /community/permit-rules`). */
  async function rules(as: Who): Promise<PermitRulesBody> {
    const res = await http('get', '/community/permit-rules', as.token);
    if (res.status === 403) return PROVISIONED;
    return status(res, 200).body as PermitRulesBody;
  }

  /** The compound's first work day on or after `from` days from today. */
  async function workDay(as: Who, from = 1): Promise<LocalDate> {
    return workDaysOf(await rules(as), 1, from)[0];
  }

  /** Every day, all day long: no rule refuses anything (a test's own). */
  const anyTime = (as: Who) =>
    setRules(as, {
      workDays: [0, 1, 2, 3, 4, 5, 6],
      workHours: { from: '00:00', to: '23:59' },
      daysOff: [],
    });

  /**
   * A works permit's body, by the compound's rules: from its first work day
   * after today, for a week, 09:00–17:00 when its hours hold them.
   */
  async function worksBody(as: Who, over: Record<string, unknown> = {}) {
    const r = await rules(as);
    const [first] = workDaysOf(r, 1, 1);
    return {
      workType: 'renovation',
      startsOn: first,
      endsOn: addDays(first, 6),
      dailyHours: withinHours(r, { from: '09:00', to: '17:00' }),
      contractorCompany: 'Nile Builders',
      description: 'New kitchen tiles',
      ...over,
    };
  }

  async function worksRaw(
    as: Who,
    unitId: string,
    over: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return await http(
      'post',
      `/units/${unitId}/permits/works`,
      as.token,
      await worksBody(as, over),
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

  /**
   * A move's body, by the compound's rules: its first work day three days
   * on or later, 10:00–12:00 when its hours hold them.
   */
  async function moveBody(as: Who, over: Record<string, unknown> = {}) {
    const r = await rules(as);
    return {
      date: workDaysOf(r, 1, 3)[0],
      window: withinHours(r, { from: '10:00', to: '12:00' }),
      truckPlate: 'ن ق ل ٤٥٦',
      itemsDescription: 'Two sofas and a fridge',
      // ADR 0063: every new move permit says which way it goes.
      direction: 'in',
      ...over,
    };
  }

  async function moveRaw(
    as: Who,
    unitId: string,
    over: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return await http(
      'post',
      `/units/${unitId}/permits/moves`,
      as.token,
      await moveBody(as, over),
      headers,
    );
  }

  /** A move permit that must be made: its body. */
  async function move(
    as: Who,
    unitId: string,
    over: Record<string, unknown> = {},
  ): Promise<PermitBody> {
    return status(await moveRaw(as, unitId, over), 201).body as PermitBody;
  }

  /** A material exit's body: from tomorrow, three days, two lines. */
  const exitBody = (over: Record<string, unknown> = {}) => ({
    validFrom: day(1),
    validUntil: day(3),
    items: [
      { name: 'Old tiles', quantity: 20 },
      { name: 'Cement bags', quantity: 4 },
    ],
    ...over,
  });

  function exitRaw(
    as: Who,
    unitId: string,
    over: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    return http(
      'post',
      `/units/${unitId}/permits/material-exits`,
      as.token,
      exitBody(over),
      headers,
    );
  }

  /** A material exit that must be made: its body. */
  async function exit(
    as: Who,
    unitId: string,
    over: Record<string, unknown> = {},
  ): Promise<PermitBody> {
    return status(await exitRaw(as, unitId, over), 201).body as PermitBody;
  }

  /** `n` guests, the first `withPlates` of them driving. */
  const guestList = (n: number, withPlates = 0) =>
    Array.from({ length: n }, (_, i) => ({
      fullName: `Guest Number ${i + 1}`,
      ...(i < withPlates ? { vehiclePlate: `GST ${i + 1}` } : {}),
    }));

  /** An event's body: in two days, 18:00 to 23:00, with `guests` guests. */
  const eventBody = (guests = 5, over: Record<string, unknown> = {}) => ({
    startsAt: at(day(2), 18).toISOString(),
    endsAt: at(day(2), 23).toISOString(),
    title: 'Birthday',
    guests: guestList(guests),
    ...over,
  });

  function eventRaw(
    as: Who,
    unitId: string,
    guests = 5,
    over: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    return http(
      'post',
      `/units/${unitId}/permits/events`,
      as.token,
      eventBody(guests, over),
      headers,
    );
  }

  /** An event that must be made: its body. */
  async function event(
    as: Who,
    unitId: string,
    guests = 5,
    over: Record<string, unknown> = {},
  ): Promise<PermitBody> {
    return status(await eventRaw(as, unitId, guests, over), 201)
      .body as PermitBody;
  }

  /** `POST /staff/unit-permits/:id/<action>` as `as`: the response. */
  function decide(
    as: Who,
    id: string,
    action: 'approve' | 'reject' | 'revoke',
    body: Record<string, unknown> = {},
  ) {
    return http('post', `/staff/unit-permits/${id}/${action}`, as.token, body);
  }

  /** Approves a permit that must be approved: the staff's view. */
  async function approve(as: Who, id: string): Promise<PermitBody> {
    return (await decide(as, id, 'approve').expect(200)).body as PermitBody;
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
    rules,
    workDay,
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
    decide,
    approve,
    moveBody,
    moveRaw,
    move,
    exitBody,
    exitRaw,
    exit,
    guestList,
    eventBody,
    eventRaw,
    event,
  };
}

export type PermitSetUp = Awaited<
  ReturnType<ReturnType<typeof permitHelpers>['setUp']>
>;
export type { Compound };
