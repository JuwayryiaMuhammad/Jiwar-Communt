import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { WorkersService } from '../../src/community/workers/workers.service';
import type { Compound } from './community';
import { bornYearsAgo, nationalIdFor } from './fixtures';
import { API, uniquePhone, type HttpHarness } from './http-app';
import { safetyHelpers, type Who } from './safety';

export type { Who } from './safety';

export interface ChildControlBody {
  id: string;
  mayLeaveAlone: boolean;
  notifyPickups: boolean;
  cardIssuedAt: string;
  photoUrl: string | null;
  turnedOnAt: string;
  escorts: number;
}

export interface ChildCardBody {
  qrPayload: string;
  firstName: string;
  unitCode: string;
  compoundName: string;
}

export interface PickupBody {
  code: string;
  qrPayload: string;
  link: string;
}

export interface EscortBody {
  id: string;
  kind: 'adult' | 'worker' | 'outside';
  accountId: string | null;
  engagementId: string | null;
  name: string | null;
  phone: string | null;
  photoUrl: string | null;
  validFrom: string;
  validUntil: string | null;
  schedule: { days: number[]; windows: { from: string; to: string }[] } | null;
  post: { gateId: string | null; gateName: string | null } | null;
  pickupIssuedAt: string | null;
  createdAt: string;
  pickup?: PickupBody | null;
}

export interface ExitBody {
  pickupId: string;
  result: 'authorized' | 'refused';
  outcome: string;
  reason: string | null;
  escort: { kind: string; firstName: string | null } | null;
}

export interface VerifyBody {
  result: 'valid';
  child: { firstName: string; photoUrl: string | null; mayLeaveAlone: boolean };
  escorts: {
    id: string;
    kind: string;
    firstName: string | null;
    photoUrl: string | null;
    validNow: boolean;
  }[];
}

export interface ChildBody {
  memberId: string;
  firstName: string;
  fullName: string;
  age: number;
  control: ChildControlBody | null;
}

/**
 * Helpers for the children suites (ADR 0054): a home with its primary,
 * minors added through the household's own route, and a child's exit
 * control over HTTP. Built on the safety helpers (guards on duty, staff,
 * files, sweeps, notifications).
 */
export function childrenHelpers(h: HttpHarness) {
  const s = safetyHelpers(h);
  const { http } = s;

  /** A compound with a home where `alice` (its primary) lives. */
  async function setUp(name = 'Children Court') {
    return s.setUp(name);
  }

  /**
   * A minor of the unit, `years` old (or turning 18 in `daysTo18` days), by
   * the primary: their member id.
   */
  async function minor(
    primary: Who,
    unitId: string,
    opts: { years?: number; daysTo18?: number; fullName?: string } = {},
  ): Promise<string> {
    const born =
      opts.daysTo18 !== undefined
        ? bornYearsAgo(18, -opts.daysTo18)
        : bornYearsAgo(opts.years ?? 8);
    const res = await http(
      'post',
      `/units/${unitId}/household/minors`,
      primary.token,
      {
        fullName: opts.fullName ?? 'Omar Young Child',
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(born),
        relation: 'child',
      },
    );
    if (res.status !== 201)
      throw new Error(`minor: ${res.status} ${JSON.stringify(res.body)}`);
    return (res.body as { id: string }).id;
  }

  const controlPath = (unitId: string, memberId: string) =>
    `/units/${unitId}/children/${memberId}/control`;

  /** `POST …/control`: the response. */
  function turnOnRaw(
    as: Who,
    unitId: string,
    memberId: string,
    body: Record<string, unknown> = {
      mayLeaveAlone: false,
      notifyPickups: true,
    },
    headers: Record<string, string> = {},
  ) {
    return http('post', controlPath(unitId, memberId), as.token, body, headers);
  }

  /** Turns it on: the control with its card. */
  async function turnOn(
    as: Who,
    unitId: string,
    memberId: string,
    body?: Record<string, unknown>,
  ): Promise<ChildControlBody & { card: ChildCardBody }> {
    const res = await turnOnRaw(as, unitId, memberId, body);
    if (res.status !== 201)
      throw new Error(`turnOn: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as ChildControlBody & { card: ChildCardBody };
  }

  /** `GET /units/:unitId/children` as `as`. */
  async function children(as: Who, unitId: string): Promise<ChildBody[]> {
    return (
      await http('get', `/units/${unitId}/children`, as.token).expect(200)
    ).body as ChildBody[];
  }

  /** A home with its primary and one minor whose control is on. */
  async function controlled(
    c: Compound,
    body?: Record<string, unknown>,
    opts: { years?: number; fullName?: string } = {},
  ) {
    const home = await s.unit(c, 'C');
    const primary = await s.owner(c, home.id);
    const memberId = await minor(primary, home.id, opts);
    const control = await turnOn(primary, home.id, memberId, body);
    return { home, primary, memberId, control };
  }

  /** The control's row. */
  function controlRow(c: Compound, id: string) {
    return s.inTx(c, (tx) =>
      tx.childControl.findUniqueOrThrow({ where: { id } }),
    );
  }

  const escortsPath = (unitId: string, memberId: string) =>
    `${controlPath(unitId, memberId)}/escorts`;

  /** `POST …/escorts`: the response. */
  function addEscortRaw(
    as: Who,
    unitId: string,
    memberId: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    return http('post', escortsPath(unitId, memberId), as.token, body, headers);
  }

  /** Adds one: the escort, with an outside person's pickup code. */
  async function addEscort(
    as: Who,
    unitId: string,
    memberId: string,
    body: Record<string, unknown>,
  ): Promise<EscortBody> {
    const res = await addEscortRaw(as, unitId, memberId, body);
    if (res.status !== 201)
      throw new Error(`addEscort: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as EscortBody;
  }

  /** An outside person, with a name and a phone nobody else has. */
  const outside = (fullName = 'Mona Outside Escort') => ({
    kind: 'outside',
    outside: { fullName, phone: uniquePhone() },
  });

  /** `GET …/escorts` as `as`. */
  async function escorts(
    as: Who,
    unitId: string,
    memberId: string,
  ): Promise<EscortBody[]> {
    return (
      await http('get', escortsPath(unitId, memberId), as.token).expect(200)
    ).body as EscortBody[];
  }

  /** `POST /public/child-pickups/lookup`, with no token: the response. */
  function pickupPage(token: string, ip = '10.7.7.7') {
    return request(h.app.getHttpServer() as Server)
      .post(`${API}/public/child-pickups/lookup`)
      .set('X-Forwarded-For', ip)
      .send({ token });
  }

  /** The token in a pickup link's fragment. */
  const tokenOf = (pickup: PickupBody) => pickup.link.split('#')[1];

  /** An approved hourly engagement of the unit, registered by its primary. */
  async function worker(c: Compound, primary: Who, unitId: string) {
    const p = s.x.person('worker');
    const reg = await s.x.as(c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef.get(WorkersService).register(unitId, {
        fullName: p.fullName,
        idDocumentType: 'national_id',
        idDocumentNumber: p.idDocumentNumber,
        phone: p.phone,
        capacity: 'nanny',
        schedule: {
          days: [0, 1, 2, 3, 4, 5, 6],
          windows: [{ from: '00:00', to: '23:59' }],
        },
      }),
    );
    const approved = await s.x.asManager(c, () =>
      h.moduleRef.get(WorkersService).review(reg.engagementId, 'approve'),
    );
    return { engagementId: reg.engagementId, fullName: p.fullName, approved };
  }

  /**
   * A resident's entry QR for now (ADR 0031): a credential registered on
   * `as`'s phone, and the mac the phone computes for the current step.
   */
  async function entryQr(as: Who): Promise<string> {
    const res = await http('post', '/me/entry-credentials', as.token, {
      deviceName: 'Child test phone',
    });
    if (res.status !== 201)
      throw new Error(`entry: ${res.status} ${JSON.stringify(res.body)}`);
    const c = res.body as { id: string; secret: string };
    const step = Math.floor(Date.now() / 30_000);
    const mac = createHmac('sha256', Buffer.from(c.secret, 'base64url'))
      .update(`${c.id}.${step}`)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    return `JWR2.${c.id}.${step}.${mac}`;
  }

  /** `POST /gate/children/verify` as a guard: the response. */
  function verifyRaw(guard: Who, card: string) {
    return http('post', '/gate/children/verify', guard.token, { card });
  }

  /** `POST /gate/children/exits` as a guard: the response. */
  function exitRaw(
    guard: Who,
    card: string,
    escort: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    return http(
      'post',
      '/gate/children/exits',
      guard.token,
      { card, escort },
      headers,
    );
  }

  /** An exit that must be recorded (201): its body. */
  async function exit(
    guard: Who,
    card: string,
    escort: Record<string, unknown>,
  ): Promise<ExitBody> {
    const res = await exitRaw(guard, card, escort);
    if (res.status !== 201)
      throw new Error(`exit: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as ExitBody;
  }

  /** The pickup's row. */
  function pickupRow(c: Compound, id: string) {
    return s.inTx(c, (tx) =>
      tx.childPickup.findUniqueOrThrow({ where: { id } }),
    );
  }

  return {
    ...s,
    s,
    entryQr,
    verifyRaw,
    exitRaw,
    exit,
    pickupRow,
    escortsPath,
    addEscortRaw,
    addEscort,
    outside,
    escorts,
    pickupPage,
    tokenOf,
    worker,
    setUp,
    minor,
    controlPath,
    turnOnRaw,
    turnOn,
    children,
    controlled,
    controlRow,
  };
}
