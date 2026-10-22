import { Client } from 'pg';
import type { Response, Test } from 'supertest';
import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import type { Permission } from '../../src/core/access/permissions';
import { RolesService } from '../../src/core/access/roles.service';
import { at, clock, day } from './compound-clock';
import type { Compound } from './community';
import { engagementHelpers, type Who } from './engagement';
import { gateHelpers } from './gate';
import { API, type HttpHarness } from './http-app';
import { required } from './test-env';

export type { Who } from './engagement';

/** Every day of the week, all day: open whenever a test runs. */
export const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 0,
  endMinute: 1440,
}));

/**
 * Rewrites rows the triggers keep, over a superuser connection with
 * `session_replication_role = replica` (TEST-ONLY, as the SLA's time
 * machine): a partner listed, or a request made, longer ago than now.
 */
export async function asSuperuser(
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  const db = new Client({
    connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
  });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query(sql, params);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }
}

/** A partner listed `days` days earlier than it was. */
export const rewindListing = (partnerId: string, days: number) =>
  asSuperuser(
    `UPDATE partners SET listed_at = listed_at - make_interval(days => $2)
      WHERE id = $1`,
    [partnerId, days],
  );

/**
 * A request's windows moved into the past (asked, proposed and agreed
 * alike, by the same interval): its window `started` a minute ago, or
 * `ended` a minute ago, without waiting.
 */
export const shiftWindow = (requestId: string, to: 'started' | 'ended') =>
  asSuperuser(
    `UPDATE partner_requests r
        SET asked_starts_at = r.asked_starts_at - x.d,
            asked_ends_at = r.asked_ends_at - x.d,
            proposed_starts_at = r.proposed_starts_at - x.d,
            proposed_ends_at = r.proposed_ends_at - x.d,
            agreed_starts_at = r.agreed_starts_at - x.d,
            agreed_ends_at = r.agreed_ends_at - x.d
       FROM (SELECT id,
                    (CASE WHEN $2 = 'started'
                          THEN COALESCE(agreed_starts_at, proposed_starts_at, asked_starts_at)
                          ELSE COALESCE(agreed_ends_at, proposed_ends_at, asked_ends_at)
                     END) - now() + interval '1 minute' AS d
               FROM partner_requests WHERE id = $1) x
      WHERE r.id = x.id`,
    [requestId, to],
  );

/** A request as the requester's views return it. */
export interface RequestBody {
  id: string;
  number: string;
  status: string;
  category: string;
  askedStartsAt: string;
  askedEndsAt: string;
  proposedStartsAt: string | null;
  agreedStartsAt: string | null;
  agreedEndsAt: string | null;
  staffCount: number | null;
  closedBy: string | null;
  closeReason: string | null;
  note: string | null;
  unitCode: string;
  items: { nameEn: string; price: string; unit: string; quantity: number }[];
  history?: { kind: string; by: string; reasonCode: string | null }[];
  [key: string]: unknown;
}

/** A request as a desk (or the relay) shows it. */
export interface DeskRequestBody {
  id: string;
  number: string;
  status: string;
  consentWithdrawn: boolean;
  unitCode: string | null;
  firstName: string | null;
  note: string | null;
  items: unknown[];
  [key: string]: unknown;
}

/** A partner as the residents' views return it. */
export interface PartnerBody {
  id: string;
  nameEn: string;
  businessPhone: string;
  serviceBuildings: string[];
  homeVisit: boolean;
  services: {
    category: string;
    subcategory: { id: string; key: string } | null;
  }[];
  hours: { weekday: number; startMinute: number; endMinute: number }[];
  priceItems: {
    id: string;
    subcategoryId: string | null;
    nameEn: string;
    price: string;
    unit: string;
  }[];
  openNow: boolean;
  openLateTonight: boolean;
  isNew: boolean;
  favourite: boolean;
  timeZone: string;
  [key: string]: unknown;
}

/**
 * Helpers for the partners suites (ADR 0060): a compound with homes in two
 * buildings and their owners, the manager, a staff member who keeps the
 * partners, and the residents' and the staff's calls over HTTP.
 */
export function partnersHelpers(h: HttpHarness) {
  const e = engagementHelpers(h);
  const { x, who, http, unit, owner, family, inTx } = e;

  /**
   * A staff account holding exactly `permissions` (by default
   * `partners.manage`). No default staff role keeps partners, so one of the
   * compound's staff roles is given them, as a manager would.
   */
  async function staff(
    c: Compound,
    permissions: Permission[] = ['partners.manage'],
  ): Promise<Who> {
    const key = permissions.length ? 'technician' : 'guard';
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

  /**
   * A compound, its manager, a keeper of partners, a home in building A and
   * one in building B, each with its owner living there (its primary).
   */
  async function setUp() {
    const c = await x.compound('Partners Court');
    const homeA = await unit(c, 'A');
    const homeB = await unit(c, 'B');
    return {
      c,
      homeA,
      homeB,
      manager: await who(c, c.managerId, 'manager'),
      keeper: await staff(c),
      alice: await owner(c, homeA.id),
      bob: await owner(c, homeB.id),
    };
  }

  /** One of the compound's seeded sub-categories, by key: its id. */
  async function subcategory(c: Compound, key: string): Promise<string> {
    return (
      await inTx(c, (tx) =>
        tx.partnerSubcategory.findFirstOrThrow({ where: { key } }),
      )
    ).id;
  }

  /**
   * `POST /staff/partners` as `by`, then its hours (open all the time
   * unless `hours` says otherwise): the partner's id. A cleaner by default.
   */
  async function partner(
    c: Compound,
    by: Who,
    over: Record<string, unknown> = {},
    hours: object[] = ALWAYS,
  ): Promise<string> {
    const created = await http('post', '/staff/partners', by.token, {
      nameEn: 'Sparkle',
      nameAr: 'سباركل',
      businessPhone: '+20225550100',
      services: [
        {
          category: 'home_services',
          subcategoryId: await subcategory(c, 'cleaning'),
        },
      ],
      ...over,
    }).expect(201);
    const id = (created.body as { id: string }).id;
    await http('put', `/staff/partners/${id}/hours`, by.token, {
      windows: hours,
    }).expect(200);
    return id;
  }

  /** `GET /partners` with filters: the partners' ids, in order. */
  async function listed(
    as: Who,
    query: Record<string, string> = {},
  ): Promise<PartnerBody[]> {
    const q = new URLSearchParams(query).toString();
    const res = await http(
      'get',
      `/partners${q ? `?${q}` : ''}`,
      as.token,
    ).expect(200);
    return (res.body as { data: PartnerBody[] }).data;
  }

  /** `GET /partners/:id`: the request, to `.expect` or await. */
  function get(as: Who, id: string): Test {
    return http('get', `/partners/${id}`, as.token);
  }

  /**
   * Hours that hold now and nothing within half an hour of either side of
   * it on any other day: today's weekday, from half an hour ago to half an
   * hour on (clipped to the day).
   */
  function openNowHours() {
    const k = clock();
    return [
      {
        weekday: k.weekday(),
        startMinute: Math.max(0, k.minute - 30),
        endMinute: Math.min(1440, k.minute + 31),
      },
    ];
  }

  /** Hours that never hold today: every other weekday, all day. */
  function closedTodayHours() {
    const today = clock().weekday();
    return ALWAYS.filter((w) => w.weekday !== today);
  }

  /** The account grants the category's consent (ADR 0036). */
  async function consent(as: Who, category = 'home_services') {
    await http('post', '/me/consents/grant', as.token, {
      code: `partner_share_${category}`,
      version: 1,
    }).expect(200);
  }

  /** The window two days ahead, `from`–`to` o'clock in the compound. */
  const windowOf = (from = 10, to = 12, days = 2) => ({
    windowStartsAt: at(day(days), from).toISOString(),
    windowEndsAt: at(day(days), to).toISOString(),
  });

  /** `POST /partner-requests`: the response. */
  function ask(
    as: Who,
    unitId: string,
    partnerId: string,
    over: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return (async () =>
      await http(
        'post',
        '/partner-requests',
        as.token,
        {
          partnerId,
          unitId,
          category: 'home_services',
          ...windowOf(),
          ...over,
        },
        headers,
      ))();
  }

  /** A request that must be made: its body. */
  async function request(
    as: Who,
    unitId: string,
    partnerId: string,
    over: Record<string, unknown> = {},
  ): Promise<RequestBody> {
    const res = await ask(as, unitId, partnerId, over);
    if (res.status !== 201)
      throw new Error(
        `request refused: ${res.status} ${JSON.stringify(res.body)}`,
      );
    return res.body as RequestBody;
  }

  /** A desk link for the partner, made by `by`: its token. */
  async function deskLink(by: Who, partnerId: string): Promise<string> {
    const res = await http(
      'post',
      `/staff/partners/${partnerId}/desk-link`,
      by.token,
    ).expect(201);
    return (res.body as { token: string }).token;
  }

  /** A call on a desk: `POST /public/partner-desk<path>` with the token. */
  function desk(token: string, path: string, body: object = {}) {
    return h
      .http()
      .post(`${API}/public/partner-desk${path}`)
      .send({ token, ...body });
  }

  /** The request's row. */
  function row(c: Compound, id: string) {
    return inTx(c, (tx) =>
      tx.partnerRequest.findUniqueOrThrow({ where: { id } }),
    );
  }

  /** The member's grant of `visitors_invite`, given by the primary. */
  function grantInvite(c: Compound, primary: Who, memberId: string) {
    return x.as(c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef
        .get(MemberPermissionsService)
        .grant(memberId, 'visitors_invite'),
    );
  }

  return {
    ...e,
    x,
    who,
    http,
    unit,
    owner,
    family,
    inTx,
    staff,
    setUp,
    subcategory,
    partner,
    listed,
    get,
    openNowHours,
    closedTodayHours,
    consent,
    windowOf,
    ask,
    request,
    deskLink,
    desk,
    row,
    grantInvite,
  };
}

export type PartnersSetUp = Awaited<
  ReturnType<ReturnType<typeof partnersHelpers>['setUp']>
>;
