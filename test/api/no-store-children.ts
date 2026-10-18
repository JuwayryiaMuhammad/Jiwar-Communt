import type { Response } from 'supertest';
import { bornYearsAgo, nationalIdFor } from '../setup/fixtures';
import { uniquePhone } from '../setup/http-app';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each of the children's no-store routes (ADR 0054), as
 * A's owner (the primary of A's home).
 */
export function childrenCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const owner = (
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    payload?: object,
  ) =>
    call(world(), method, path, {
      token: world().a.tokens.owner,
      body: payload,
    });
  const home = () => world().a.homeUnitId;
  /** A new minor of A's home: their member id. */
  const aMinor = async () =>
    (
      (
        await owner('POST', `/units/${home()}/household/minors`, {
          fullName: 'No Store Child',
          idDocumentType: 'national_id',
          idDocumentNumber: nationalIdFor(bornYearsAgo(7)),
          relation: 'child',
        })
      ).body as { id: string }
    ).id;
  /** A minor of A's home whose control is on: their member id. */
  const aControlled = async () => {
    const memberId = await aMinor();
    await owner('POST', `/units/${home()}/children/${memberId}/control`, {
      mayLeaveAlone: false,
      notifyPickups: true,
    });
    return memberId;
  };
  const escorts = (memberId: string) =>
    `/units/${home()}/children/${memberId}/control/escorts`;
  /** An outside escort of a new controlled child: the child and the response. */
  const anEscort = async () => {
    const memberId = await aControlled();
    const res = await owner('POST', escorts(memberId), {
      kind: 'outside',
      outside: { fullName: 'No Store Escort', phone: uniquePhone() },
    });
    return {
      memberId,
      id: (res.body as { id: string }).id,
      token: (res.body as { pickup: { link: string } }).pickup.link.split(
        '#',
      )[1],
    };
  };
  return {
    'GET /units/{unitId}/children/{memberId}/control/escorts': async () => {
      const e = await anEscort();
      return owner('GET', escorts(e.memberId));
    },
    'POST /units/{unitId}/children/{memberId}/control/escorts': async () =>
      owner('POST', escorts(await aControlled()), {
        kind: 'outside',
        outside: { fullName: 'No Store Escort', phone: uniquePhone() },
      }),
    'PATCH /units/{unitId}/children/{memberId}/control/escorts/{id}':
      async () => {
        const e = await anEscort();
        return owner('PATCH', `${escorts(e.memberId)}/${e.id}`, {
          validUntil: null,
        });
      },
    'POST /units/{unitId}/children/{memberId}/control/escorts/{id}/reissue':
      async () => {
        const e = await anEscort();
        return owner('POST', `${escorts(e.memberId)}/${e.id}/reissue`);
      },
    'POST /public/child-pickups/lookup': async () =>
      call(world(), 'POST', '/public/child-pickups/lookup', {
        body: { token: (await anEscort()).token },
      }),
    'GET /units/{unitId}/children': async () => {
      await aControlled();
      return owner('GET', `/units/${home()}/children`);
    },
    'POST /units/{unitId}/children/{memberId}/control': async () =>
      owner('POST', `/units/${home()}/children/${await aMinor()}/control`, {
        mayLeaveAlone: false,
        notifyPickups: true,
      }),
    'PATCH /units/{unitId}/children/{memberId}/control': async () =>
      owner(
        'PATCH',
        `/units/${home()}/children/${await aControlled()}/control`,
        { notifyPickups: false },
      ),
    'POST /units/{unitId}/children/{memberId}/control/card': async () =>
      owner(
        'POST',
        `/units/${home()}/children/${await aControlled()}/control/card`,
      ),
  };
}
