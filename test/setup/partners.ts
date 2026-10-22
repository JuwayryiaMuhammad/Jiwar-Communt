import { Client } from 'pg';
import type { Response, Test } from 'supertest';
import type { Permission } from '../../src/core/access/permissions';
import { RolesService } from '../../src/core/access/roles.service';
import { clock } from './compound-clock';
import type { Compound } from './community';
import { engagementHelpers, type Who } from './engagement';
import { gateHelpers } from './gate';
import type { HttpHarness } from './http-app';
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
  };
}

export type PartnersSetUp = Awaited<
  ReturnType<ReturnType<typeof partnersHelpers>['setUp']>
>;
