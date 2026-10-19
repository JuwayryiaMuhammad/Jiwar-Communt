import { WorkersService } from '../../src/community/workers/workers.service';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { FIELD_EXCEPTIONS_SWEEP } from '../../src/gate/exceptions/field-exceptions.service';
import { VISIT_OVERSTAY_SWEEP } from '../../src/gate/visitors/visit-overstay.sweep';
import { SERVICE_VEHICLE_EXITS_SWEEP } from '../../src/gate/service-vehicles/service-vehicles.service';
import type { Compound } from './community';
import { aroundTheClock, dbClock, hhmm, localMinute } from './compound-clock';
import { nationalIdFor, uniqueSuffix } from './fixtures';
import { superuserSql } from './governance';
import { uniqueEmail, uniquePhone, type HttpHarness } from './http-app';
import { securityOpsHelpers, type Who } from './security-ops';

export type { Who } from './security-ops';

/** A field exception as the guard reads it (ADR 0056). */
export interface GuardExceptionBody {
  id: string;
  reference: string;
  kind: string;
  reasonCode: string;
  unitCode: string;
  gateId: string;
  status: string;
  raisedAt: string;
  answerBy: string;
  decidedAt: string | null;
  rejectReasonCode: string | null;
  entryUntil: string | null;
  usedAt: string | null;
  worker: { type: string; id: string } | null;
}

/** As the management reads it. */
export interface StaffExceptionBody extends GuardExceptionBody {
  gateName: string;
  raisedBy: { id: string; fullName: string | null };
  decidedBy: { id: string; fullName: string | null } | null;
  visitorName: string | null;
  vehiclePlate: string | null;
  workerName: string | null;
}

/**
 * Helpers for the suites of the gate's completion (ADR 0056), on top of the
 * security ones: a compound with a guard on shift at a gate, workers on and
 * off their schedule, the field exceptions over HTTP, and time travel.
 */
export function gateCompletionHelpers(h: HttpHarness) {
  const x = securityOpsHelpers(h);

  /** A compound, its manager, a home (alice its primary), a guard on shift and the home's code. */
  async function setUp(name = 'Gate Completion Court') {
    const s = await x.setUp(name);
    const guard = await x.guardOnDuty(s.c);
    return { ...s, guard, unitCode: s.home.code };
  }

  /** Another manager of the compound, with a session: a second decider. */
  async function manager(c: Compound): Promise<Who> {
    const account = await x.x.x.asManager(c, () =>
      h.moduleRef.get(AccountsService).create({
        type: 'manager',
        fullName: `Manager ${uniqueSuffix()}`,
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(),
        phone: uniquePhone(),
        email: uniqueEmail('manager'),
      }),
    );
    return x.who(c, account.id, 'manager');
  }

  /**
   * An approved household worker of the unit, registered by its primary:
   * `outside` open for one minute twelve hours from now (so never now),
   * otherwise open every day but for that minute.
   */
  async function worker(
    c: Compound,
    primary: Who,
    unitId: string,
    schedule: 'inside' | 'outside',
  ) {
    const minute = (localMinute(dbClock()) + 720) % 1440;
    const start = Math.min(minute, 1438);
    const p = x.x.x.person('worker');
    const reg = await x.x.x.as(c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef.get(WorkersService).register(unitId, {
        fullName: p.fullName,
        idDocumentType: 'national_id',
        idDocumentNumber: p.idDocumentNumber,
        phone: p.phone,
        capacity: 'nanny',
        schedule:
          schedule === 'inside'
            ? aroundTheClock()
            : {
                days: [0, 1, 2, 3, 4, 5, 6],
                windows: [{ from: hhmm(start), to: hhmm(start + 1) }],
              },
      }),
    );
    await x.x.x.asManager(c, () =>
      h.moduleRef.get(WorkersService).review(reg.engagementId, 'approve'),
    );
    return { engagementId: reg.engagementId, fullName: p.fullName };
  }

  /** `POST /gate/field-exceptions` as `as`. */
  function raiseRaw(
    as: Who,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    return x.http(
      'post',
      '/gate/field-exceptions',
      as.token,
      { reasonCode: 'resident_unreachable', ...body },
      headers,
    );
  }

  /** An exception that must be raised: its body. */
  async function raise(
    as: Who,
    body: Record<string, unknown>,
  ): Promise<GuardExceptionBody> {
    const res = await raiseRaw(as, body);
    if (res.status !== 201)
      throw new Error(`raise: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as GuardExceptionBody;
  }

  /** A visitor's exception for the unit: the most common kind. */
  const visitor = (as: Who, unitCode: string, over: object = {}) =>
    raise(as, { kind: 'visitor_without_pass', unitCode, ...over });

  /** `POST /staff/gate/field-exceptions/:id/decide` as `as`. */
  function decideRaw(
    as: Who,
    id: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    return x.http(
      'post',
      `/staff/gate/field-exceptions/${id}/decide`,
      as.token,
      body,
      headers,
    );
  }

  const approve = async (as: Who, id: string): Promise<StaffExceptionBody> =>
    (await decideRaw(as, id, { decision: 'approve' }).expect(200))
      .body as StaffExceptionBody;

  /** `GET /gate/field-exceptions/:id` as a guard. */
  const follow = async (as: Who, id: string): Promise<GuardExceptionBody> =>
    (await x.http('get', `/gate/field-exceptions/${id}`, as.token).expect(200))
      .body as GuardExceptionBody;

  /** `GET /staff/gate/field-exceptions/:id` as the management. */
  const staffView = async (as: Who, id: string): Promise<StaffExceptionBody> =>
    (
      await x
        .http('get', `/staff/gate/field-exceptions/${id}`, as.token)
        .expect(200)
    ).body as StaffExceptionBody;

  /** The exception's row. */
  const row = (c: Compound, id: string) =>
    x.inTx(c, (tx) =>
      tx.gateFieldException.findUniqueOrThrow({ where: { id } }),
    );

  /** Its answer deadline moved `minutes` into the past: time travel. */
  const pastDeadline = (id: string, minutes = 1) =>
    superuserSql(
      `UPDATE gate_field_exceptions
          SET raised_at = $2::timestamptz - interval '10 minutes',
              answer_by = $2
        WHERE id = $1`,
      [id, new Date(dbClock().getTime() - minutes * 60_000)],
    );

  /** Its entry window moved `minutes` into the past (an approved one). */
  const pastEntryWindow = (id: string, minutes = 1) =>
    superuserSql(
      `UPDATE gate_field_exceptions
          SET raised_at = $2::timestamptz - interval '40 minutes',
              answer_by = $2::timestamptz - interval '30 minutes',
              decided_at = $2::timestamptz - interval '20 minutes',
              entry_until = $2
        WHERE id = $1`,
      [id, new Date(dbClock().getTime() - minutes * 60_000)],
    );

  /**
   * A visitor pass of the unit by `host`, valid from now for six hours by
   * the database's clock: its id and code.
   */
  async function pass(
    host: Who,
    unitId: string,
    over: Record<string, unknown> = {},
  ): Promise<{ id: string; code: string }> {
    const now = dbClock();
    const res = await x.http(
      'post',
      `/units/${unitId}/visitor-passes`,
      host.token,
      {
        kind: 'one_time',
        partySize: 1,
        // A minute back: dbClock() is the runner's clock plus a skew
        // measured once, and may run a few ms ahead of the server's, which
        // dates an entry; a pass valid from "now" could be not yet valid.
        validFrom: new Date(now.getTime() - 60_000).toISOString(),
        validUntil: new Date(now.getTime() + 6 * 3_600_000).toISOString(),
        ...over,
      },
    );
    if (res.status !== 201)
      throw new Error(`pass: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; code: string };
  }

  /** An entry that must be recorded: its id. */
  async function enter(
    as: Who,
    subjectType: string,
    subjectId: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await x.entryRaw(as, subjectType, subjectId, over);
    if (res.status !== 201)
      throw new Error(`entry: ${res.status} ${JSON.stringify(res.body)}`);
    return (res.body as { id: string }).id;
  }

  /** An entry moved `minutes` into the past: time travel past its trigger. */
  const backdate = (entryId: string, minutes: number) =>
    superuserSql(
      `UPDATE gate_entries SET occurred_at = $2, recorded_at = $2 WHERE id = $1`,
      [entryId, new Date(dbClock().getTime() - minutes * 60_000)],
    );

  /** One run of the overstay sweep. */
  const sweepOverstay = () => x.sweep(VISIT_OVERSTAY_SWEEP, dbClock());

  /** `POST /gate/service-vehicles` as `as`. */
  function serviceInRaw(
    as: Who,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    return x.http(
      'post',
      '/gate/service-vehicles',
      as.token,
      { kind: 'tanker', company: 'Nile Water Co', ...body },
      headers,
    );
  }

  /** A service vehicle that must come in: its body. */
  async function serviceIn(
    as: Who,
    plate: string,
    over: Record<string, unknown> = {},
  ): Promise<{ id: string; plate: string; exitedAt: string | null }> {
    const res = await serviceInRaw(as, { plate, ...over });
    if (res.status !== 201)
      throw new Error(`service in: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; plate: string; exitedAt: string | null };
  }

  /** `POST /gate/service-vehicles/:id/exit` as `as`. */
  const serviceOutRaw = (as: Who, id: string) =>
    x.http('post', `/gate/service-vehicles/${id}/exit`, as.token);

  /** A service vehicle's entry moved `minutes` into the past. */
  const backdateService = (id: string, minutes: number) =>
    superuserSql(
      `UPDATE service_vehicle_visits SET entered_at = $2, created_at = $2 WHERE id = $1`,
      [id, new Date(dbClock().getTime() - minutes * 60_000)],
    );

  /** One run of the service vehicles' unconfirmed exits. */
  const sweepServiceExits = () =>
    x.sweep(SERVICE_VEHICLE_EXITS_SWEEP, dbClock());

  /** The gate's settings, changed by the manager. */
  const settings = (manager: Who, body: Record<string, unknown>) =>
    x.http('patch', '/staff/gate/settings', manager.token, body).expect(200);

  /** One run of the exceptions' sweep, at `now` (the database's clock). */
  const sweepExceptions = (now: Date = dbClock()) =>
    x.sweep(FIELD_EXCEPTIONS_SWEEP, now);

  return {
    ...x,
    x,
    setUp,
    manager,
    worker,
    raiseRaw,
    raise,
    visitor,
    decideRaw,
    approve,
    follow,
    staffView,
    row,
    pastDeadline,
    pastEntryWindow,
    sweepExceptions,
    pass,
    enter,
    backdate,
    sweepOverstay,
    settings,
    serviceInRaw,
    serviceIn,
    serviceOutRaw,
    backdateService,
    sweepServiceExits,
  };
}
