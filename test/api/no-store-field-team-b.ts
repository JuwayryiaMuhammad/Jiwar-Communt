import type { Response } from 'supertest';
import { addDays } from '../../src/core/common/slots/day-slots';
import { newId } from '../../src/core/common/uuid';
import { today } from '../setup/compound-clock';
import type { Compound } from '../setup/community';
import { gateHelpers } from '../setup/gate';
import { call } from './request';
import type { World } from './world';

const HOUR = 3_600_000;
/** An ISO instant `ms` from now: a call's window. */

const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

/**
 * A real call for each no-store route of the field team's part b (ADR
 * 0090), as A's manager or a technician of A's. What holds one open at a
 * time in a compound (an access review, a reinforcement suggestion) is
 * called in a compound of its own, so no call answers 409 for another's.
 */
export function fieldTeamBCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const as = (
    token: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    payload?: object,
  ) => call(world(), method, path, { token, body: payload });
  const manager = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    payload?: object,
  ) => as(world().a.tokens.manager, method, path, payload);
  const id = (res: Response) => (res.body as { id: string }).id;

  /** A fresh technician of `c` (A by default), off duty, and a token. */
  const technician = async (c: Compound = world().a) => {
    const w = world();
    const tech = await gateHelpers(w.h).guard(c, 'technician');
    return {
      id: tech.id,
      token: await w.h.tokenFor({
        sub: tech.id,
        tid: c.tenantId,
        typ: 'staff',
      }),
    };
  };
  /** A compound of its own, its manager's token. */
  const compound = async () => {
    const w = world();
    const c = await w.helpers.compound('No-store Checks Court');
    return {
      c,
      token: await w.h.tokenFor({
        sub: c.managerId,
        tid: c.tenantId,
        typ: 'manager',
      }),
    };
  };
  const certificate = () =>
    manager('POST', '/staff/field-team/certificates', {
      accountId: world().a.ids.technician,
      kind: 'first_aid',
      title: 'First aid',
      expiresOn: addDays(today(), 100),
    });
  /** An open finding of a fresh account of A's, as the sweep makes one. */
  const finding = async () => {
    const w = world();
    const tech = await gateHelpers(w.h).guard(w.a, 'technician');
    const fid = newId();
    await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.danglingAccountFinding.create({
        data: {
          id: fid,
          tenantId: w.a.tenantId,
          accountId: tech.id,
          reason: 'never_signed_in',
          foundAt: new Date(),
        },
      }),
    );
    return fid;
  };
  /** A review open in a compound of its own, with a technician's line. */
  const review = async () => {
    const own = await compound();
    const tech = await technician(own.c);
    const res = await as(own.token, 'POST', '/staff/access/reviews');
    const body = res.body as {
      id: string;
      reviewLines: { id: string; account: { id: string } }[];
    };
    return {
      ...own,
      id: body.id,
      line: body.reviewLines.find((l) => l.account.id === tech.id)!.id,
    };
  };
  /** A call of A's field team reaching a fresh technician. */
  const sent = async (hoursAhead: number) => {
    const tech = await technician();
    const res = await manager('POST', '/staff/field-team/reinforcement-calls', {
      needed: 2,
      startsAt: ahead(hoursAhead * HOUR),
      endsAt: ahead((hoursAhead + 1) * HOUR),
    });
    return { id: id(res), tech };
  };

  return {
    'GET /technician/location-consent': () =>
      as(world().a.tokens.technician, 'GET', '/technician/location-consent'),
    'POST /technician/location-consent': () =>
      as(world().a.tokens.technician, 'POST', '/technician/location-consent'),
    'DELETE /technician/location-consent': () =>
      as(world().a.tokens.technician, 'DELETE', '/technician/location-consent'),
    'GET /staff/field-team/technicians/{id}/location': () =>
      manager(
        'GET',
        `/staff/field-team/technicians/${world().a.ids.technician}/location`,
      ),
    'GET /staff/field-team/certificates': () =>
      manager('GET', '/staff/field-team/certificates'),
    'POST /staff/field-team/certificates': () => certificate(),
    'GET /staff/field-team/certificates/{id}': async () =>
      manager(
        'GET',
        `/staff/field-team/certificates/${id(await certificate())}`,
      ),
    'PATCH /staff/field-team/certificates/{id}': async () =>
      manager(
        'PATCH',
        `/staff/field-team/certificates/${id(await certificate())}`,
        { title: 'First aid, renewed' },
      ),
    'GET /staff/my-certificates': () =>
      as(world().a.tokens.technician, 'GET', '/staff/my-certificates'),
    'GET /staff/access/settings': () =>
      manager('GET', '/staff/access/settings'),
    'PATCH /staff/access/settings': () =>
      manager('PATCH', '/staff/access/settings', { idleDays: 60 }),
    'GET /staff/access/dangling-accounts': () =>
      manager('GET', '/staff/access/dangling-accounts'),
    'GET /staff/access/dangling-accounts/{id}': async () =>
      manager('GET', `/staff/access/dangling-accounts/${await finding()}`),
    'POST /staff/access/dangling-accounts/{id}/keep': async () =>
      manager(
        'POST',
        `/staff/access/dangling-accounts/${await finding()}/keep`,
        { reasonCode: 'rarely_needed' },
      ),
    'POST /staff/access/dangling-accounts/{id}/deactivate': async () =>
      manager(
        'POST',
        `/staff/access/dangling-accounts/${await finding()}/deactivate`,
      ),
    'GET /staff/access/reviews': () => manager('GET', '/staff/access/reviews'),
    'POST /staff/access/reviews': async () => {
      const own = await compound();
      return as(own.token, 'POST', '/staff/access/reviews');
    },
    'GET /staff/access/reviews/{id}': async () => {
      const r = await review();
      return as(r.token, 'GET', `/staff/access/reviews/${r.id}`);
    },
    'POST /staff/access/reviews/{id}/lines/{lineId}/decide': async () => {
      const r = await review();
      return as(
        r.token,
        'POST',
        `/staff/access/reviews/${r.id}/lines/${r.line}/decide`,
        { decision: 'keep' },
      );
    },
    'GET /staff/field-team/reinforcement-suggestions': () =>
      manager('GET', '/staff/field-team/reinforcement-suggestions'),
    'POST /staff/field-team/reinforcement-suggestions/{id}/dismiss':
      async () => {
        const own = await compound();
        const sid = newId();
        await world().helpers.asManager(own.c, () =>
          world().helpers.prisma.tenant.reinforcementSuggestion.create({
            data: {
              id: sid,
              tenantId: own.c.tenantId,
              raisedAt: new Date(),
              openTickets: 5,
              available: 1,
              threshold: 3,
              createdAt: new Date(),
            },
          }),
        );
        return as(
          own.token,
          'POST',
          `/staff/field-team/reinforcement-suggestions/${sid}/dismiss`,
          { reasonCode: 'enough_on_duty' },
        );
      },
    'POST /staff/field-team/reinforcement-calls': async () =>
      as(
        world().a.tokens.manager,
        'POST',
        '/staff/field-team/reinforcement-calls',
        { needed: 1, startsAt: ahead(HOUR), endsAt: ahead(2 * HOUR) },
      ),
    'GET /staff/field-team/reinforcement-calls': () =>
      manager('GET', '/staff/field-team/reinforcement-calls'),
    'GET /staff/field-team/reinforcement-calls/{id}': async () =>
      manager(
        'GET',
        `/staff/field-team/reinforcement-calls/${(await sent(2)).id}`,
      ),
    'POST /staff/field-team/reinforcement-calls/{id}/cancel': async () =>
      manager(
        'POST',
        `/staff/field-team/reinforcement-calls/${(await sent(3)).id}/cancel`,
        { reasonCode: 'no_longer_needed' },
      ),
    'GET /maintenance/reinforcement-calls': async () => {
      const s = await sent(4);
      return as(s.tech.token, 'GET', '/maintenance/reinforcement-calls');
    },
    'POST /maintenance/reinforcement-calls/{id}/accept': async () => {
      const s = await sent(5);
      return as(
        s.tech.token,
        'POST',
        `/maintenance/reinforcement-calls/${s.id}/accept`,
      );
    },
    'POST /maintenance/reinforcement-calls/{id}/decline': async () => {
      const s = await sent(6);
      return as(
        s.tech.token,
        'POST',
        `/maintenance/reinforcement-calls/${s.id}/decline`,
      );
    },
  };
}
