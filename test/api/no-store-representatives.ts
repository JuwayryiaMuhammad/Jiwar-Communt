import type { Response } from 'supertest';
import { newId } from '../../src/core/common/uuid';
import { superuserSql } from '../setup/governance';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each building representative route (ADR 0059). A's
 * owner represents the building of A's home, where A's landlord (on the
 * suite's board) owns the rented unit; the term is written straight in
 * (the board's size here varies, so no motion is carried), and the
 * landlord writes to them.
 * A matter raised to end that term is withdrawn after each call that
 * raised it, so the next finds none pending. Made once, lazily.
 */
export function representativeCalls(
  world: () => World,
  sitting: () => Promise<void>,
): Record<string, () => Promise<Response>> {
  const as =
    (persona: 'manager' | 'landlord' | 'owner') =>
    (method: 'GET' | 'POST', path: string, payload?: object) =>
      call(world(), method, path, {
        token: world().a.tokens[persona],
        body: payload,
      });
  const manager = as('manager');
  const landlord = as('landlord');
  const owner = as('owner');
  const id = (res: Response) => (res.body as { id: string }).id;
  const ok = (res: Response) => {
    if (res.status >= 300)
      throw new Error(`no-store: ${res.status} ${JSON.stringify(res.body)}`);
    return res;
  };

  let made: Promise<{ representativeId: string; threadId: string }> | null =
    null;
  /** The building, its representative and a thread written to them. */
  const representation = () =>
    (made ??= (async () => {
      const a = world().a;
      // A's home (the owner's) and the rented unit (the landlord's) are in
      // building NS: no one gains a unit, so no other route's caller now
      // owns two (a poll's vote, an RSVP would then need to name one).
      await superuserSql(
        `UPDATE units SET building = 'NS' WHERE id = ANY($1::uuid[])`,
        [[a.homeUnitId, a.rentedUnitId]],
      );
      const unitId = a.homeUnitId;
      const matterId = newId();
      await superuserSql(
        `INSERT INTO governance_representative_matters
                (id, tenant_id, action, building, account_id, raised_by_account_id,
                 raised_at, deadline_at, status, withdrawn_at, withdrawn_by_account_id)
         VALUES ($1, $2, 'appoint', 'NS', $3, $4, now(), now() + interval '14 days',
                 'withdrawn', now(), $4)`,
        [matterId, a.tenantId, a.ids.owner, a.ids.landlord],
      );
      const representativeId = newId();
      await superuserSql(
        `INSERT INTO governance_representatives
                (id, tenant_id, building, account_id, unit_id, appointed_at, appointed_by_matter_id)
         VALUES ($1, $2, 'NS', $3, $4, now(), $5)`,
        [representativeId, a.tenantId, a.ids.owner, unitId, matterId],
      );
      ok(
        await landlord(
          'POST',
          `/me/representatives/${representativeId}/messages`,
          { body: 'No-store message' },
        ),
      );
      const threads = ok(await owner('GET', '/me/representation/threads'))
        .body as { data: { id: string }[] };
      return { representativeId, threadId: threads.data[0].id };
    })());

  /** A pending matter to end the term, raised by the landlord. */
  const aMatter = async () => {
    await sitting();
    return id(
      ok(
        await landlord('POST', '/board/representatives/matters', {
          action: 'end',
          representativeId: (await representation()).representativeId,
        }),
      ),
    );
  };
  /** The call, then the matter withdrawn (its open motion with it). */
  const thenWithdraw = async (matterId: string, res: Response) => {
    ok(
      await landlord(
        'POST',
        `/board/representatives/matters/${matterId}/withdraw`,
      ),
    );
    return res;
  };

  return {
    'GET /board/representatives': async () => {
      await sitting();
      return landlord('GET', '/board/representatives');
    },
    'GET /board/representatives/buildings': async () => {
      await representation();
      await sitting();
      return landlord('GET', '/board/representatives/buildings');
    },
    'GET /board/representatives/candidates': async () => {
      await representation();
      await sitting();
      return landlord('GET', '/board/representatives/candidates?building=NS');
    },
    'POST /board/representatives/matters': async () => {
      await sitting();
      const res = await landlord('POST', '/board/representatives/matters', {
        action: 'end',
        representativeId: (await representation()).representativeId,
      });
      return thenWithdraw(id(ok(res)), res);
    },
    'GET /board/representatives/matters': async () => {
      await sitting();
      return landlord('GET', '/board/representatives/matters');
    },
    'GET /board/representatives/matters/{id}': async () => {
      const matterId = await aMatter();
      return thenWithdraw(
        matterId,
        await landlord('GET', `/board/representatives/matters/${matterId}`),
      );
    },
    'POST /board/representatives/matters/{id}/motions': async () => {
      const matterId = await aMatter();
      return thenWithdraw(
        matterId,
        await landlord(
          'POST',
          `/board/representatives/matters/${matterId}/motions`,
          { outcome: 'reject', rationale: 'No-store reasons' },
        ),
      );
    },
    'POST /board/representatives/matters/{id}/withdraw': async () =>
      landlord(
        'POST',
        `/board/representatives/matters/${await aMatter()}/withdraw`,
      ),
    'GET /staff/governance/representatives': () =>
      manager('GET', '/staff/governance/representatives'),
    'GET /me/representatives': () => owner('GET', '/me/representatives'),
    'GET /me/representatives/{id}/messages': async () =>
      landlord(
        'GET',
        `/me/representatives/${(await representation()).representativeId}/messages`,
      ),
    'POST /me/representatives/{id}/messages': async () =>
      landlord(
        'POST',
        `/me/representatives/${(await representation()).representativeId}/messages`,
        { body: 'No-store message' },
      ),
    'GET /me/representation/threads': async () => {
      await representation();
      return owner('GET', '/me/representation/threads');
    },
    'GET /me/representation/threads/{id}/messages': async () =>
      owner(
        'GET',
        `/me/representation/threads/${(await representation()).threadId}/messages`,
      ),
    'POST /me/representation/threads/{id}/messages': async () =>
      owner(
        'POST',
        `/me/representation/threads/${(await representation()).threadId}/messages`,
        { body: 'No-store answer' },
      ),
  };
}
