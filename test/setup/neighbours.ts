import { Client } from 'pg';
import type { Response } from 'supertest';
import { DelegationsService } from '../../src/community/households/delegations.service';
import { RolesService } from '../../src/core/access/roles.service';
import type { Permission } from '../../src/core/access/permissions';
import type { Compound } from './community';
import { engagementHelpers, type Who } from './engagement';
import { fileHelpers } from './files';
import { gateHelpers } from './gate';
import type { HttpHarness } from './http-app';
import { required } from './test-env';

export type { Who } from './engagement';

/**
 * Helpers for the neighbours suites (ADR 0042): a compound with two homes
 * in two buildings, the people of each, staff who handle or manage, and
 * the residents' and the staff's calls over HTTP.
 */
export function neighboursHelpers(h: HttpHarness) {
  const e = engagementHelpers(h);
  const { x, who, http, unit, owner, tenant, landlord, family, inTx } = e;
  const files = fileHelpers(h);

  /**
   * A staff account holding exactly `permissions` (by default the
   * handler's). No default staff role holds a neighbours permission, so
   * one of the compound's staff roles is given them, as a manager would in
   * the roles screen: a role per set.
   */
  async function staff(
    c: Compound,
    permissions: Permission[] = ['neighbours.handle'],
  ): Promise<Who> {
    const set = [...permissions].sort().join(',');
    const key =
      set === 'neighbours.handle'
        ? 'maintenance_supervisor'
        : permissions.length
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
   * A compound, its manager, a handler, and two homes: Alice owns and
   * lives in one in building A, Bob in one in building B.
   */
  async function setUp() {
    const c = await x.compound('Neighbours Court');
    const homeA = await unit(c, 'A');
    const homeB = await unit(c, 'B');
    return {
      c,
      homeA,
      homeB,
      manager: await who(c, c.managerId, 'manager'),
      handler: await staff(c),
      alice: await owner(c, homeA.id),
      bob: await owner(c, homeB.id),
    };
  }

  /** The primary delegates the household to a member, for thirty days. */
  function delegate(
    c: Compound,
    unitId: string,
    primary: Who,
    member: Who,
    scopes: ('household' | 'workers')[] = ['household'],
  ) {
    return x.as(c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef.get(DelegationsService).create(
        unitId,
        member.id,
        scopes,
        // eslint-disable-next-line no-restricted-syntax -- any future instant within a year: a delegation's expiry is an instant
        new Date(Date.now() + 30 * 86_400_000),
      ),
    );
  }

  /** Ends every active occupancy of the account in the unit: they moved out. */
  async function moveOut(c: Compound, unitId: string, account: Who) {
    const rows = await x.occupancies(c, unitId);
    for (const o of rows)
      if (o.accountId === account.id && o.status === 'active')
        await x.asManager(c, () =>
          x.residents.endOccupancy(o.id, {
            code: 'moved_out',
            text: 'Moved out',
          }),
        );
  }

  async function categoryId(c: Compound, key = 'noise'): Promise<string> {
    const category = await x.asManager(c, () =>
      x.prisma.tenant.neighbourComplaintCategory.findFirstOrThrow({
        where: { key },
      }),
    );
    return category.id;
  }

  /** `PATCH /neighbours/settings` as the manager. */
  function settings(c: Compound, manager: Who, patch: Record<string, number>) {
    return http('patch', '/neighbours/settings', manager.token, patch).expect(
      200,
    );
  }

  // --------------------------------------------------------------------------
  // Complaints
  // --------------------------------------------------------------------------

  /**
   * `POST /neighbour-complaints` as `author` against the unit of
   * `targetCode`: the response, with supertest's `.expect(status)`.
   */
  function complainRaw(
    c: Compound,
    author: Who,
    targetCode: string,
    over: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<Response> & { expect(status: number): Promise<Response> } {
    const sent: Promise<Response> = (async () =>
      await http(
        'post',
        '/neighbour-complaints',
        author.token,
        {
          categoryId: await categoryId(c),
          targetUnitCode: targetCode,
          body: 'Loud music every night',
          ...over,
        },
        headers,
      ))();
    return Object.assign(sent, {
      expect: async (status: number) => {
        const res = await sent;
        if (res.status !== status)
          throw new Error(
            `expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`,
          );
        return res;
      },
    });
  }

  async function complain(
    c: Compound,
    author: Who,
    targetCode: string,
    over: Record<string, unknown> = {},
  ): Promise<{ id: string; number: string; status: string }> {
    const res = await complainRaw(c, author, targetCode, over);
    if (res.status !== 201)
      throw new Error(`complain: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; number: string; status: string };
  }

  /** A staff action on a complaint: `POST /neighbours/complaints/{id}/{action}`. */
  const onComplaint = (by: Who, id: string, action: string, body?: object) =>
    http('post', `/neighbours/complaints/${id}/${action}`, by.token, body);

  /** Reviewed, and its notice sent: the notice's id. */
  async function noticed(
    by: Who,
    complaintId: string,
    body = 'Please keep the noise down after 10 pm.',
  ): Promise<string> {
    await onComplaint(by, complaintId, 'review').expect(204);
    const res = await onComplaint(by, complaintId, 'notice', { body }).expect(
      201,
    );
    return (res.body as { id: string }).id;
  }

  // --------------------------------------------------------------------------
  // The boards
  // --------------------------------------------------------------------------

  async function post(
    author: Who,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await http('post', '/neighbour-posts', author.token, {
      kind: 'found',
      body: 'A set of keys with a red tag',
      place: 'Near gate 2',
      ...over,
    });
    if (res.status !== 201)
      throw new Error(`post: ${res.status} ${JSON.stringify(res.body)}`);
    return (res.body as { id: string }).id;
  }

  async function staffPost(
    by: Who,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await http('post', '/neighbours/posts', by.token, {
      kind: 'found',
      body: 'A phone left at the pool',
      ...over,
    }).expect(201);
    return (res.body as { id: string }).id;
  }

  async function claim(
    by: Who,
    postId: string,
    note?: string,
  ): Promise<string> {
    const res = await http(
      'post',
      `/neighbour-posts/${postId}/claims`,
      by.token,
      note ? { note } : {},
    ).expect(201);
    return (res.body as { id: string }).id;
  }

  /** `POST /neighbour-posts/{id}/conversations`: the response. */
  const contact = (by: Who, postId: string, body = 'Is it still available?') =>
    http('post', `/neighbour-posts/${postId}/conversations`, by.token, {
      body,
    });

  /** A conversation `by` started on the post: its id. */
  async function conversation(by: Who, postId: string): Promise<string> {
    const res = await contact(by, postId).expect(201);
    return (res.body as { id: string }).id;
  }

  /** A finalized file of the caller's, of a neighbours purpose. */
  const file = (
    by: Who,
    purpose: 'complaint_evidence' | 'neighbour_post_photo',
    contentType = 'image/png',
  ) => files.ready(by.token, purpose, contentType);

  /** Moves a post's day into the past: it has left its board. */
  async function expire(c: Compound, postId: string): Promise<void> {
    // The trigger keeps `expires_at`: only a superuser with triggers off
    // rewrites it, which is what a test's time machine is (ADR 0034).
    const db = new Client({
      connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
    });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query(`SET LOCAL session_replication_role = replica`);
      await db.query(
        `UPDATE neighbour_posts
            SET created_at = now() - interval '40 days',
                expires_at = now() - interval '1 day'
          WHERE id = $1 AND tenant_id = $2`,
        [postId, c.tenantId],
      );
      await db.query('COMMIT');
    } finally {
      await db.end();
    }
  }

  /** The body of a list response. */
  async function list<T = Record<string, unknown>>(
    path: string,
    by: Who,
  ): Promise<T[]> {
    return (
      (await http('get', path, by.token).expect(200)).body as { data: T[] }
    ).data;
  }

  return {
    ...e,
    x,
    who,
    http,
    unit,
    owner,
    tenant,
    landlord,
    family,
    inTx,
    staff,
    setUp,
    delegate,
    moveOut,
    categoryId,
    settings,
    complainRaw,
    complain,
    onComplaint,
    noticed,
    post,
    staffPost,
    claim,
    contact,
    conversation,
    file,
    expire,
    list,
  };
}

export type NeighboursSetUp = Awaited<
  ReturnType<ReturnType<typeof neighboursHelpers>['setUp']>
>;
