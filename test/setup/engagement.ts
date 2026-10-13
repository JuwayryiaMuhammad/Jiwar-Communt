import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import { RolesService } from '../../src/core/access/roles.service';
import type { Permission } from '../../src/core/access/permissions';
import { newId } from '../../src/core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../src/core/database/tenant-tx.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import type { Compound } from './community';
import { fileHelpers } from './files';
import { uniqueSuffix } from './fixtures';
import { gateHelpers } from './gate';
import type { HttpHarness } from './http-app';
import { managementHelpers, type Who } from './management';

export type { Who } from './management';

const HOUR = 3_600_000;

/** A poll as either side's view returns it. */
export interface PollBody {
  id: string;
  status: string;
  turnout: number | null;
  resultsHidden: string | null;
  options: { id: string; position: number; votes: number | null }[];
  units?: {
    unitId: string;
    mayVote: boolean;
    voted: boolean;
    choice: string[] | null;
  }[];
}

/**
 * Helpers for the community life suites (ADR 0040): a compound with units
 * in buildings, people in every capacity an audience tells apart, and the
 * staff's and residents' calls over HTTP.
 */
export function engagementHelpers(h: HttpHarness) {
  const m = managementHelpers(h);
  const { x, who, http } = m;
  const files = fileHelpers(h);

  /** A unit in a building (or in none). */
  async function unit(c: Compound, building: string | null = 'A') {
    return x.asManager(c, () =>
      x.prisma.tenant.unit.create({
        data: {
          id: newId(),
          tenantId: c.tenantId,
          code: `U-${uniqueSuffix()}`,
          building,
        },
      }),
    );
  }

  /** An owner who lives in the unit (its primary, when the first). */
  async function owner(c: Compound, unitId: string): Promise<Who> {
    return who(c, (await x.resident(c, [unitId])).id, 'resident');
  }

  async function tenant(c: Compound, unitId: string): Promise<Who> {
    return who(c, (await x.resident(c, [unitId], 'tenant')).id, 'resident');
  }

  /** An owner who does not live in the unit. */
  async function landlord(c: Compound, unitId: string): Promise<Who> {
    const created = await x.asManager(c, () =>
      x.residents.createResident({
        ...x.person('landlord'),
        units: [{ unitId, occupancyType: 'owner', resides: false }],
      }),
    );
    return who(c, created.id, 'resident');
  }

  /** An adult member of the unit's household, with a login. */
  async function family(
    c: Compound,
    unitId: string,
    primary: Who,
  ): Promise<Who & { memberId: string }> {
    const joined = await x.joinFamily(c, unitId, primary);
    return {
      ...(await who(c, joined.accountId, 'family')),
      memberId: joined.memberId,
    };
  }

  /** The primary gives a member the unit's vote in polls. */
  function grantVote(c: Compound, primary: Who, memberId: string) {
    return x.as(c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef.get(MemberPermissionsService).grant(memberId, 'polls_vote'),
    );
  }

  /**
   * A staff account holding exactly `permissions`. No default staff role
   * holds a community permission (ADR 0040), so one of the compound's staff
   * roles is given them, as a manager would in the roles screen: a role per
   * set, so two staff members of one suite never share a role by accident.
   */
  async function staff(c: Compound, permissions: Permission[]): Promise<Who> {
    const set = [...permissions].sort().join(',');
    const key =
      set === 'community.publish'
        ? 'maintenance_supervisor'
        : set === 'community.suggestions'
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

  /**
   * A compound, its manager, a unit in building A and the owner who lives
   * there (its primary).
   */
  async function setUp() {
    const c = await x.compound('Engagement Court');
    const home = await unit(c, 'A');
    return {
      c,
      home,
      manager: await who(c, c.managerId, 'manager'),
      owner: await owner(c, home.id),
    };
  }

  const at = (hours: number) => new Date(Date.now() + hours * HOUR);

  /** A transaction in the compound, as its manager: for raw reads of the tables. */
  const inTx = <T>(c: Compound, fn: (tx: TenantTxClient) => Promise<T>) =>
    x.asManager(c, () => h.moduleRef.get(TenantTx).withTenantTx(fn));

  // --------------------------------------------------------------------------
  // Announcements
  // --------------------------------------------------------------------------

  /** `POST /community/announcements`: a draft; its id. */
  async function draft(
    by: Who,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await http('post', '/community/announcements', by.token, {
      kind: 'general',
      titleEn: 'Water',
      bodyEn: 'The water will be off on Friday.',
      ...over,
    }).expect(201);
    return (res.body as { id: string }).id;
  }

  /** A draft, published now (or scheduled for `publishAt`). */
  async function announcement(
    by: Who,
    over: Record<string, unknown> = {},
    publishAt?: Date,
  ): Promise<string> {
    const id = await draft(by, over);
    await http('post', `/community/announcements/${id}/publish`, by.token, {
      ...(publishAt ? { publishAt } : {}),
    }).expect(204);
    return id;
  }

  /** Works and closures, published now. */
  function works(by: Who, over: Record<string, unknown> = {}) {
    return announcement(by, {
      kind: 'works',
      titleEn: 'Road works',
      bodyEn: 'The main road is closed.',
      works: { startsAt: at(-1), endsAt: at(2), areaKind: 'road' },
      ...over,
    });
  }

  // --------------------------------------------------------------------------
  // Events
  // --------------------------------------------------------------------------

  async function event(
    by: Who,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await http('post', '/community/events', by.token, {
      titleEn: 'Garden day',
      descriptionEn: 'Bring a hat.',
      place: 'The central garden',
      startsAt: at(48),
      endsAt: at(50),
      ...over,
    }).expect(201);
    return (res.body as { id: string }).id;
  }

  const rsvp = (
    as: Who,
    eventId: string,
    body: Record<string, unknown> = { response: 'going' },
  ) => http('put', `/events/${eventId}/rsvp`, as.token, body);

  // --------------------------------------------------------------------------
  // Polls
  // --------------------------------------------------------------------------

  /** An open poll with two options (more with `over.options`); its id. */
  async function poll(
    by: Who,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await http('post', '/community/polls', by.token, {
      questionEn: 'Repaint the gate?',
      options: [{ labelEn: 'Yes' }, { labelEn: 'No' }],
      closesAt: at(72),
      ...over,
    }).expect(201);
    return (res.body as { id: string }).id;
  }

  async function pollAs(as: Who, pollId: string): Promise<PollBody> {
    return (await http('get', `/polls/${pollId}`, as.token).expect(200))
      .body as PollBody;
  }

  async function pollForStaff(by: Who, pollId: string): Promise<PollBody> {
    return (
      await http('get', `/community/polls/${pollId}`, by.token).expect(200)
    ).body as PollBody;
  }

  /** The poll's option ids, in order. */
  async function optionIds(by: Who, pollId: string): Promise<string[]> {
    return (await pollForStaff(by, pollId)).options.map((o) => o.id);
  }

  const vote = (
    as: Who,
    pollId: string,
    optionIds: string[],
    over: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) =>
    http(
      'post',
      `/polls/${pollId}/votes`,
      as.token,
      { optionIds, ...over },
      headers,
    );

  /**
   * `n` more units, each with an owner who lives there (its primary), in
   * the given building: enough voters to pass the five-unit threshold.
   */
  async function voters(
    c: Compound,
    n: number,
    building: string | null = 'A',
  ): Promise<{ unitId: string; who: Who }[]> {
    const out: { unitId: string; who: Who }[] = [];
    for (let i = 0; i < n; i++) {
      const u = await unit(c, building);
      out.push({ unitId: u.id, who: await owner(c, u.id) });
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Suggestions
  // --------------------------------------------------------------------------

  /** The id of one of the compound's seeded suggestion topics. */
  async function topicId(c: Compound, key = 'general'): Promise<string> {
    const topic = await x.asManager(c, () =>
      x.prisma.tenant.suggestionTopic.findFirstOrThrow({ where: { key } }),
    );
    return topic.id;
  }

  async function suggestion(
    c: Compound,
    author: Who,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await http('post', '/suggestions', author.token, {
      topicId: await topicId(c),
      body: 'A bench near the gate, please.',
      ...over,
    }).expect(201);
    return (res.body as { id: string }).id;
  }

  /** On the board, under the staff's summary. */
  const publish = (
    by: Who,
    suggestionId: string,
    over: Record<string, unknown> = {},
  ) =>
    http('post', `/community/suggestions/${suggestionId}/publish`, by.token, {
      titleEn: 'More benches',
      textEn: 'Residents asked for more places to sit.',
      ...over,
    });

  const move = (
    by: Who,
    suggestionId: string,
    status: string,
    response?: string,
  ) =>
    http('post', `/community/suggestions/${suggestionId}/status`, by.token, {
      status,
      ...(response ? { response } : {}),
    });

  // --------------------------------------------------------------------------
  // Time and files
  // --------------------------------------------------------------------------

  /** Runs one sweep as the app's timer would, at `now`. */
  const sweep = (name: string, now = new Date()) =>
    h.moduleRef.get(SweepRunner).run(name, now);

  /** A finalized `community_attachment` of the caller's. */
  const attachment = (by: Who, contentType = 'image/png') =>
    files.ready(by.token, 'community_attachment', contentType);

  /** The account's notifications of a kind, as rows. */
  function notifications(c: Compound, accountId: string, kind?: string) {
    return x.asManager(c, () =>
      x.prisma.tenant.notification.findMany({
        where: { accountId, ...(kind ? { kind } : {}) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  }

  return {
    ...m,
    x,
    who,
    http,
    unit,
    owner,
    tenant,
    landlord,
    family,
    grantVote,
    staff,
    setUp,
    at,
    inTx,
    draft,
    announcement,
    works,
    event,
    rsvp,
    poll,
    pollAs,
    pollForStaff,
    optionIds,
    vote,
    voters,
    topicId,
    suggestion,
    publish,
    move,
    sweep,
    attachment,
    notifications,
  };
}

export type EngagementSetUp = Awaited<
  ReturnType<ReturnType<typeof engagementHelpers>['setUp']>
>;
