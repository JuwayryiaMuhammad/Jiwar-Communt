import type { Server } from 'node:http';
import request from 'supertest';
import { RolesService } from '../../src/core/access/roles.service';
import { communityHelpers, type Compound } from './community';
import { gateHelpers } from './gate';
import { API, type HttpHarness } from './http-app';

/** An account of the suite with a token of its own. */
export interface Who {
  id: string;
  token: string;
}

/**
 * Helpers for the management request suites (ADR 0039): a compound with its
 * manager, a household (its primary and a family member) and calls over
 * HTTP as any of them.
 */
export function managementHelpers(h: HttpHarness) {
  const x = communityHelpers(h);
  const g = gateHelpers(h);

  async function who(
    c: Compound,
    id: string,
    type: 'staff' | 'manager' | 'resident' | 'family',
  ): Promise<Who> {
    return {
      id,
      token: await h.tokenFor({ sub: id, tid: c.tenantId, typ: type }),
    };
  }

  /** A compound, its manager, a unit and the unit's owner (its primary). */
  async function setUp() {
    const c = await x.compound();
    const unit = await x.unit(c);
    const owner = await x.resident(c, [unit.id]);
    return {
      c,
      unit,
      manager: await who(c, c.managerId, 'manager'),
      owner: await who(c, owner.id, 'resident'),
    };
  }

  /**
   * A staff account that handles requests and does nothing else: no default
   * staff role holds `requests.handle` (ADR 0039), so the compound's
   * maintenance supervisor role is given it and it alone, as a manager
   * would in the roles screen.
   */
  async function handler(c: Compound): Promise<Who> {
    await x.asManager(c, async () => {
      const role = await x.prisma.tenant.role.findUniqueOrThrow({
        where: {
          tenantId_key: { tenantId: c.tenantId, key: 'maintenance_supervisor' },
        },
      });
      await h.moduleRef
        .get(RolesService)
        .replacePermissions(role.id, ['requests.handle']);
    });
    return who(c, (await g.guard(c, 'maintenance_supervisor')).id, 'staff');
  }

  /** The id of one of the compound's seeded topics. */
  async function topicId(c: Compound, key = 'general'): Promise<string> {
    const topic = await x.asManager(c, () =>
      x.prisma.tenant.managementRequestTopic.findFirstOrThrow({
        where: { key },
      }),
    );
    return topic.id;
  }

  /** `POST /management-requests` as `author`; the created view. */
  async function open(
    c: Compound,
    author: Who,
    over: Record<string, unknown> = {},
  ): Promise<{ id: string; number: string; status: string }> {
    const res = await http('post', '/management-requests', author.token, {
      type: 'question',
      topicId: await topicId(c),
      body: 'When is the pool open?',
      ...over,
    }).expect(201);
    return res.body as { id: string; number: string; status: string };
  }

  /** The free slots the API offers the author, soonest first. */
  async function slots(
    who: Who,
    days = 14,
  ): Promise<{ startsAt: string; endsAt: string }[]> {
    const res = await http(
      'get',
      `/management-appointment-slots?days=${days}`,
      who.token,
    ).expect(200);
    // Not the ones about to become too soon: a booking made a moment after
    // this read must still be an hour ahead.
    const soon = Date.now() + 2 * 3_600_000;
    return (
      res.body as { data: { startsAt: string; endsAt: string }[] }
    ).data.filter((slot) => new Date(slot.startsAt).getTime() > soon);
  }

  /** `POST /management-requests` of type appointment on `startsAt`. */
  function book(
    c: Compound,
    author: Who,
    startsAt: string,
    topic: string,
    over: Record<string, unknown> = {},
  ) {
    return http('post', '/management-requests', author.token, {
      type: 'appointment',
      topicId: topic,
      body: 'I would like to meet the management',
      appointment: { startsAt, mode: 'in_person' },
      ...over,
    });
  }

  const http = (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    token: string,
    body?: object,
    headers: Record<string, string> = {},
  ) => {
    const agent = request(h.app.getHttpServer() as Server);
    let req = agent[method](`${API}${path}`).set(
      'Authorization',
      `Bearer ${token}`,
    );
    for (const [name, value] of Object.entries(headers))
      req = req.set(name, value);
    return method === 'get' || method === 'delete' ? req : req.send(body ?? {});
  };

  return { x, who, setUp, handler, topicId, open, slots, book, http };
}

export type ManagementSetUp = Awaited<
  ReturnType<ReturnType<typeof managementHelpers>['setUp']>
>;
