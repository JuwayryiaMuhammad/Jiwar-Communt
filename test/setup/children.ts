import type { Compound } from './community';
import { bornYearsAgo, nationalIdFor } from './fixtures';
import type { HttpHarness } from './http-app';
import { safetyHelpers, type Who } from './safety';

export type { Who } from './safety';

export interface ChildControlBody {
  id: string;
  mayLeaveAlone: boolean;
  notifyPickups: boolean;
  cardIssuedAt: string;
  photoUrl: string | null;
  turnedOnAt: string;
}

export interface ChildCardBody {
  qrPayload: string;
  firstName: string;
  unitCode: string;
  compoundName: string;
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

  return {
    ...s,
    s,
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
